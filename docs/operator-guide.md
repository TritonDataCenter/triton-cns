---
title: CNS Operator Guide
markdown2extras: tables, code-friendly, cuddled-lists, fenced-code-blocks
---
<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->
<!--
    Copyright (c) 2016, Joyent, Inc.
-->

## Introduction

CNS is one of the less opinionated services in the SDC / Triton suite, due to
the nature of DNS deployments, which vary considerably from one situation to
another. This means that unlike many of the other SDC services, there is no
"one true way" to deploy CNS, and it has a fairly flexible configuration.

Basically, it's designed to integrate into whatever DNS setup you already
have. This can make it a little confusing at first, as there are many paths to
take to deploy and integrate CNS.

This document will describe the basics of setting up CNS in a few common
situations, and provide some general advice about ways to customize it for
your needs. It sadly can't cover all the possible tweaks you can use for
your individual setup, but a sizeable fraction of the space will be covered.

## CNS components

The basic core component of CNS is a service zone that is deployed on your SDC
headnode. It contains two services, the `cns-updater`, and the `cns-server`.
The `cns-updater` is responsible for gathering data from all of the other APIs
and parts of SDC and turning it into DNS records, and then the `cns-server` is
responsible for serving these DNS records to clients (and other nameservers).

The `cns-server` also provides a small REST API that can be used to inspect the
state of the overall system. There's a commandline tool `cnsadm` that comes
pre-installed inside the CNS zone which can be used to interrogate it. The
`cnsadm` command has a manpage that is useful to read if you want to know
more about this (you can also [view it online](https://github.com/joyent/triton-cns/blob/master/man/src/cnsadm.md)).

Configuration for the CNS system as a whole is stored in the SAPI metadata
for the CNS SAPI service. This can be edited by hand using the `sapiadm`
and `sdc-sapi` commands, but `cnsadm` provides a much friendlier interface
that also handles validation for you, ensuring that you can't commit an
invalid config that will put CNS services into "maintenance" (the SMF state
where they are no longer eligible for restart until "cleared").

Outside the core zone, there are components of your DNS infrastructure that
can also participate in the CNS system. Any nameserver that can perform
standard DNS zone transfers (AXFR/IXFR) can be a secondary nameserver for
CNS and replicate all of its records, and this is the path to achieving
availability and scalability with CNS.

## How clients look up names in CNS

One very important thing to consider and fully understand before your CNS
deployment is how your client machines will look up names from CNS.

Your "client machines" may mean just the machines on your company intranet (for
internal use only), or might mean any machine on the Internet (for public use).

When a client machine goes to look up a name in DNS, it will have a local
configuration file (typically `/etc/resolv.conf`), which specifies a number of
*recursive nameservers* to be used to perform lookups. Often these are servers
provided by an ISP or some local cache.

If you want to use CNS in a restricted corporate intranet setting where the
records are only resolvable from inside your network, you will need to have
the recursive nameservers used by all client machines under your control. They
need to be talking to a nameserver that you can configure so that it knows
where to find CNS directly (there are a few ways to do this).

If clients are using public recursive nameservers, or ones belonging to an ISP,
then they will obey only the DNS resolution rules for the public Internet,
meaning that you will have to make your CNS records available to the entire
Internet, and set up delegation and glue records correctly so that these
recursive nameservers know how to find your CNS.

CNS is designed to primarily function as an *authoritative nameserver*, rather
than a recursive one. This means that clients do not directly query it for all
of their DNS lookups, but instead are referred to it by their normal recursive
nameserver (or the recursive nameserver makes the query on their behalf).

However, it *can* be used in small deployments as a recursive nameserver that
answers only for names under the configured CNS zone. It has been implemented
to return a `SERVFAIL` error for names outside its designated suffix, so that
client implementations will assume there was an error and move on to the next
nameserver they know about.

This mode of operation carries a number of pathological failure modes in the
face of network interruptions and downtime of the CNS zone, which is why it
is not the preferred deployment configuration. It is very useful for
development and testing, however.

## Example deployment designs

### Small development/testing setup

 - CNS zone on headnode, with a NIC on `external` (192.168.1.22)
 - Client machines all have 192.168.1.22 listed explicitly in their
   `/etc/resolv.conf` files, and can reach this address
 - Names are not resolvable from the public Internet

### Internal-only corporate setup

Existing infrastructure before CNS:
 - Pair of existing company recursive nameservers running ISC BIND, on
   10.1.1.10 and 10.1.1.11
 - All client machines configured to use these as their recursive nameservers

CNS deployment:
 - CNS zone on headnode, with a NIC on `external` (10.1.2.5)
 - CNS has the existing recursive nameservers whitelisted as replication peers
 - Existing recursive nameservers configured to be authoritative for the CNS
   suffix and set to use 10.1.2.5 as the "master" for the zone
 - Client machines do not communicate with CNS directly at all -- the recursive
   nameservers are replicating the records from CNS and then answering queries
   entirely on their own

### Publically resolvable setup

Existing infrastructure before CNS:
 - A single "master" nameserver, running ISC BIND, on 123.45.67.10 (public IP)
 - Two geographically diverse "slave" nameservers, also BIND
 - `example.com` zone is served by all 3 NS and has appropriate glue and
   delegation from root nameservers

CNS deployment:
 - CNS zone on headnode, with a NIC on `public` (123.45.67.60)
 - CNS is configured in hidden master mode
 - CNS has the existing "master" and "slave" nameservers whitelisted as
   replication peers
 - Existing "master" and "slave" nameservers are all configured to use
   123.45.67.60 as a master for `cns.example.com`
 - NS glue records are added in the `example.com` zone listing only the 
   "master" and two "slave" nameservers that pre-date CNS

In this setup, all CNS generated names are resolvable from the public Internet.

### Hybrid setup

We can also make a hybrid of the "publically resolvable" and "internal-only
corporate" designs from above, as CNS supports multiple DNS zones at once where
each zone contains only containers/VMs that have NICs on some particular subset
of your SDC networks. This can be useful in order to make some "public" subset
of your containers visible to the outside world whilst keeping internal
interfaces and addresses private.

In this case, we actually set up both designs at once from the two previous
sections, but only configure the "public" zone in hidden master mode. The
combination of the two works because each set of nameservers (the public
Internet-facing set, and the internal recursive set) only replicate their
particular zone from the CNS server.

## DNS zones

Another key factor you should consider before beginning your CNS deployment is
the set of DNS zones you wish to use. A DNS zone is a sub-tree of the DNS
hierarchy -- e.g. you could own the domain `example.com`, and use the zone
`cns.example.com` for CNS -- so your actual CNS hostnames would appear as
`foobar.cns.example.com`.

Since containers and instances in Triton may have NICs on multiple networks (
and therefore multiple IP addresses), it is often useful to distinguish between
them. If you deployed CNS with a single DNS zone in use, in the default
configuration, you would find that looking up a CNS name returns to you all of
the IP addresses of a container mixed together as one list, regardless of
whether some are "private" or "public" in your deployment. This may be
undesirable if you expect users to connect only to some of these addresses
(because, for example, some may not be accessible from the outside).

CNS supports the use of multiple DNS zones to make this distinction clear. The
most typical use is to have one DNS zone for "public" IP addresses, and one for
"private" IP addresses. It is worth noting that these do *not* have to be
actual private IP addresses in terms of RFC1918 (e.g. in the subnets
`10.0.0.0/8`, `192.168.0.0/16` etc) -- this is about the semantic use of the
network in your deployment.

DNS zones handled by CNS can either be configured to list IP addresses only
from a defined set of networks (or network pools), or can be configured as
"catch-all" or "wildcard" zones, which list all remaining addresses. The most
typical configurations are to list "only public IP addresses", and to list
"public" and "private" addresses in two separate zones (often the "private"
zone is made a catch-all zone so it can list Fabric networks).

### Example: only public IP addresses in CNS

Triton setup:
 - One network, "external", with Internet public IP addresses in `192.0.2.0/24`
 - Another network "internal", with addresses in `10.0.0.0/24`
 - Fabric networking enabled, user has a private fabric

CNS zone configuration:
 - DNS zone: `cns.foo.com`, configured with `networks = [ "external" ]`
   (explicit list)

Example:
 - A container named `test` is deployed by user `jim`, with NICs on
   "external", "internal", and `jim`'s private fabric

Results:
 - `test.inst.jim.cns.foo.com` resolves only to the "external" address of the
   `test` container. The "internal" and fabric addresses are not in DNS.

### Example: split public/private zones

Triton setup:
 - One network, "external", with Internet public IP addresses in `192.0.2.0/24`
 - Another network "internal", with addresses in `10.0.0.0/24`
 - Fabric networking enabled, user has a private fabric

CNS zone configuration:
 - DNS zone: `ext.foobar.com`, configured with `networks = [ "external" ]`
 - DNS zone: `int.foobar.com`, configured with `networks = [ "*" ]`
   (a catch-all or wildcard zone)

Example:
 - A container named `test` is deployed by user `jill`, with NICs on
   "external", "internal", and `jill`'s private fabric

Results:
 - `test.inst.jill.ext.foobar.com` resolves only to the "external" address of
   the `test` container.
 - `test.inst.jill.int.foobar.com` resolves to both the "internal" address and
   the private fabric address of the `test` container (there will be two `A`
   records served for this name)

## Tasks

### Setting up CNS for the first time

To create the CNS service and zone on your headnode:

```
[root@headnode ~]# sdcadm experimental cns
...
[root@headnode ~]# sdcadm experimental update-other
...
[root@headnode ~]# sdcadm update -C dev -y cns
...
```

The first step sets up the CNS zone itself and the SAPI service for it. The
second activates some SAPI metadata that is necessary for the CloudAPI
integration to work.

The third step is only recommended right now as CNS is still in fairly heavy
development. Running a CNS image from the "dev" channel with the rest of the
SDC services on "release" is recommended for the moment, to avoid using a
CNS image that is missing important bug fixes. When the code is more stable,
this step will be removed.

*Note*: the second step (`sdcadm experimental update-other`) will trigger a
restart of the CloudAPI service in your datacenter (and thus a very brief
outage). Make sure you've advised your users in advance.

### Entering the CNS zone and viewing configuration

To enter the CNS zone and view the current configuration of the system:

```
[root@headnode ~]# sdc-login cns
...
[root@uuid (dc:cns0) ~]# cnsadm config
my_name:         cns.dc.joyent.us
hostmaster:      hostmaster@joyent.us
use_login:       false
use_alias:       true
allow_transfer:  127.0.0.1
[root@uuid (dc:cns0) ~]# cnsadm zones
ZONE                     NETWORKS   PEERS                      HIDDEN PRIMARY
dc.cns.joyent.us         *                                     false
(ip-reverse-lookup)                                            false
```

These two commands (`cnsadm config` and `cnsadm zones`) give a basic overview
of how CNS is currently configured. The above example output shows the default
configuration that will appear after creating a new CNS zone in a datacenter
called `dc` with a DNS suffix of `joyent.us`.

Currently this CNS will generate records under the DNS zone `dc.cns.joyent.us`
for all enabled VMs in the datacenter on all networks (indicated by the `*`).
It is not set up to allow any replication peers, and is not configured as a
Hidden Primary. Note that "enabled VMs" refers to those belonging to SDC
accounts with the `triton_cns_enabled` flag set (see the
[user documentation for CNS](https://docs.joyent.com/public-cloud/network/cns/usage)).

An example instance record in this zone could look like
`example.inst.6bfa28b6-e64c-11e5-adf5-5703f12edb00.dc.cns.joyent.us` (the zone
name is the suffix appended after the user UUID).

The information presented in `cnsadm config` is used across all DNS zones
served by CNS. The first two fields, `my_name` and `hostmaster` determine
the information that appears in `SOA` (start-of-authority) records. These
records identify metadata about a DNS zone and its management.

The fields `use_login` and `use_alias` determine whether VM/container aliases
(short names) and user logins will be used in DNS names. By default, container
aliases are used, and user logins are not (this is the configuration deployed
in the Joyent Public Cloud). CNS will always generate records corresponding to
the UUIDs of containers and users -- these flags only determine whether to
additionally generate records with shorter friendly names.

For example, if `use_login` was enabled, the example instance record mentioned
above could also be found under the name `example.inst.fred.dc.cns.joyent.us`,
given that the owner's login username is `fred`.

The `allow_transfer` field contains a list of IP addresses or CIDR-format
subnet masks that should be allowed to become replication peers. Note that
this has some overlap with the "peers" property on a particular zone.

You can also view detailed configuration about one zone using `cnsadm`:

```
[root@uuid (dc:cns0) ~]# cnsadm zones dc.cns.joyent.us
zone:            dc.cns.joyent.us
networks:        *
peers:           []
hidden_primary:  false
```

This is particularly useful if the information was truncated in the table
summary display, as will often happen when network UUIDs are explicitly
listed under `networks`, or more than one replication peer is used.

### Configuring DNS zones

From the CNS zone on the headnode, you can use the `cnsadm zones` command to
manage DNS zones in the CNS configuration. This is the output of `cnsadm zones`
with no arguments, for a typical default configuration:

```
[root@uuid (dc:cns0) ~]# cnsadm zones
ZONE                     NETWORKS   PEERS                      HIDDEN PRIMARY
dc.cns.joyent.us         *                                     false
(ip-reverse-lookup)                                            false
```

Here we have a single DNS zone, `dc.cns.joyent.us`, configured as a catch-all
or wildcard zone (indicated by `*` under `NETWORKS`).

To change this to a "public IP addresses only" configuration, we would simply
modify the network list on the zone:

```
[root@uuid (dc:cns0) ~]# cnsadm zones dc.cns.joyent.us networks=8c26b4f8-b67e-11e6-8ee4-ffb3a2f73c8d
```

(where `8c26b4f8-b67e-11e6-8ee4-ffb3a2f73c8d` is the UUID of the "external"
network on this deployment -- you can obtain this UUID from the Networking tab
in AdminUI, or by using the `sdc-napi` command)

This would change the output of `cnsadm zones` to now look like:

```
[root@uuid (dc:cns0) ~]# cnsadm zones
ZONE                     NETWORKS   PEERS                      HIDDEN PRIMARY
dc.cns.joyent.us         (1 UUIDs)                             false
(ip-reverse-lookup)                                            false
```

Now, if we wanted to change to a public-private split configuration, we would
add a second zone as a new wildcard:

```
[root@uuid (dc:cns0) ~]# cnsadm zones -a dc-int.cns.joyent.us networks=*
```

And the new output of `cnsadm zones`:

```
[root@uuid (dc:cns0) ~]# cnsadm zones
ZONE                     NETWORKS   PEERS                      HIDDEN PRIMARY
dc.cns.joyent.us         (1 UUIDs)                             false
dc-int.cns.joyent.us     *                                     false
(ip-reverse-lookup)                                            false
```

The `man` reference page about the `cnsadm` command includes further examples
of modifying, adding and removing DNS zones. Type `man cnsadm` while logged
into the CNS zone for further details.

### Checking CNS status

Enter the CNS zone from the headnode, and check that no services are down
or in maintenance:

```
[root@headnode ~]# sdc-login cns
...
[root@uuid (dc:cns0) ~]# svcs -x
```

If `svcs -x` produces no output, then all services are running.

If it does produce output, take a look in the service logs for any malfunctioning services. In particular, the two SMF services `cns-updater` and
`cns-server` are relevant. You can use a command like
`tail -n 500 $(svcs -L cns-updater) | bunyan` to view nicely formatted logs
from the `cns-updater` service.

The logs should give hints as to the source of your trouble, but it is likely
if you reach this point that you have encountered a bug. Please include these
logs and also information about the CNS configuration in your bug report, which
you should file on the 
[GitHub `triton-cns` repository](https://github.com/joyent/triton-cns/issues).

If services are running normally, use the `cnsadm status` command to check last changed times, serial numbers and the status of replication peers:

```
[root@uuid (staging-1:cns0) ~]# cnsadm status
ZONE                     LATEST SERIAL  CHANGED
staging-1.cns.joyent.us  373423966      3 days ago
3.26.172.in-addr.arpa    373178900      4 wks ago

PEER         ZONE                     LATEST SERIAL  DRIFT  VERSION
172.24.2.49  3.26.172.in-addr.arpa    373178900             ISC BIND 9.10.3-P3
             staging-1.cns.joyent.us  373423966
```

This output is from a real working configuration to show what the replication
peer status output looks like.

Here we can see that this CNS is configured with the zone
`staging-1.cns.joyent.us`, and has generated records for it, as there is a 
valid serial number given. Reverse-lookup records have also been generated for
IP addresses under `172.26.3.x`.

This CNS currently has 1 known replication peer, `172.24.2.49`, which has 
replicated both zones from it. We can see that the latest serial the peer has
copied from us is the same as the latest serial generated. If this were not
the case, there would be a note in the "DRIFT" column highlighting that this
peer was behind.

We can also see, if available, the version of software running on the peer, to
help with debugging.

The commandline tool `dig` can also be very valuable in debugging DNS-related
problems. The tool is pre-installed in the CNS zone, as well as the SDC
headnode. You can use it to look up a particular name for testing:

```
[root@uuid (dc:cns0) ~]# dig example.inst.fred.dc.cns.joyent.us @localhost
...
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 39569
;; flags: qr aa rd ad; QUERY: 1, ANSWER: 1, AUTHORITY: 1, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1200
;; QUESTION SECTION:
;example.inst.fred.dc.cns.joyent.us.        IN A
;; ANSWER SECTION:
example.inst.fred.dc.cns.joyent.us. 30 IN A 172.26.3.49

;; AUTHORITY SECTION:
dc.cns.joyent.us. 3600   IN      NS      cns.dc.joyent.us.
...
```

Here we can see that CNS returned the address `172.26.3.49` for this name.
`dig` also displays very detailed information about the contents of the DNS
packets exchanged with the server, which can help to point out problems.

### Adding an ISC BIND server as a replication peer

Starting from the default configuration for `dc.joyent.us` shown above, we will
proceed to set up an ISC BIND nameserver as a replication peer or "slave" (in
BIND terminology) to serve CNS records.

First, as our BIND server is going to be placed on the `external` network, we
will need to give the CNS zone an IP on that network as well to communicate
with the BIND server.

```
[root@headnode ~]# /usbkey/scripts/add_external_nic.sh $(vmadm lookup alias=cns0)
[root@headnode ~]# vmadm get $(vmadm lookup alias=cns0) | json nics | json -a nic_tag ip
admin 10.0.0.107
external 10.0.1.82
```

Our existing BIND nameserver is running on `10.0.1.10`, and is known by the DNS
name `ns1.joyent.us`.

Add the nameserver as a replication peer in CNS:

```
[root@headnode ~]# sdc-login cns
...
[root@uuid (dc:cns0) ~]# cnsadm config allow_transfer+=10.0.1.10
[root@uuid (dc:cns0) ~]# cnsadm zones dc.cns.joyent.us peers+=ns1.joyent.us
```

And now add the following snippet into the BIND configuration file:

```
masters cns {
    10.0.1.82;
};

zone "dc.cns.joyent.us" {
    type slave;
    file "slave/dc.cns.joyent.us";
    masters { cns; };
};
```

Reload the configuration:

```
[user@nameserver ~]$ rndc reload
```

And finally, check the output of `cnsadm status` to verify that the peer is
now known and in sync:

```
[root@uuid (dc:cns0) ~]# cnsadm status
ZONE                     LATEST SERIAL  CHANGED
dc.cns.joyent.us         373423966      1 minute ago
1.0.10.in-addr.arpa      373423966      1 minute ago

PEER         ZONE                     LATEST SERIAL  DRIFT  VERSION
10.0.1.10    1.0.10.in-addr.arpa      373423966             ISC BIND 9.10.2-P1
             dc.cns.joyent.us         373423966
```

### Extra debugging information about record generation

One of the most common problems encountered in new setups is that CNS is not
generating all the records expected by a user. To debug CNS's decision-making
process to see why it did not list a VM's records in the way you expected, the
logs of the `cns-updater` service are useful.

The `cns-updater` logs include a `DEBUG` level message for every time CNS
examines a VM and decides what records should be created, which includes
reasoning tags as to what criteria influenced the decision.

For example, to look at CNS's reasoning about the VM with UUID
`99a430dd-88a3-4cc4-9046-c76810491445`, use the following command inside the
CNS zone:

```
# cat $(svcs -L cns-updater) | grep 99a430dd-88a3-4cc4-9046-c76810491445 | bunyan
```

The log messages with reasoning information will look like this:

```
[2016-07-06T17:38:28.294Z] DEBUG: cns/24595 on 859bd73b-9766-444b-ac8d-ea2f8209fea8: updating vm (stage=UpdateStream)
    info: {
      "vm": "99a430dd-88a3-4cc4-9046-c76810491445",
      "why": [
        "vm_down"
      ],
      "l_s": false,
      "l_i": true,
      "svcs": [
        {
          "name": "gerrit",
          "ports": []
        }
      ],
      "c": {
        "staging-1.cns.joyent.us": 4,
        "3.26.172.in-addr.arpa": 1
      },
      "o": "reaper"
    }
```

The exact fields here are subject to change since they are not a guaranteed
API, but below are their definitions at the time of writing:

 - `"vm"` contains the VM's UUID
 - `"l_s"` means "list services" -- if it's true, CNS decided to generate
   service records for this VM (`.svc.`)
 - `"l_i"` means "list instance" -- if it's true, CNS decided to generate
   instance records
 - `"svcs"` contains an array of all the recognized services in this VM's
   `triton.cns.services` tag
 - `"c"` contains *counts* of final generated records within each DNS zone
 - `"o"` shows the origin of this visit to the VM (the reason why CNS was
   looking at it to begin with)
 - `"why"` contains a list of all the decision flags that affected this VM

Some examples of decision flags that may be seen in the `"why"` field:

 - `"user_en_flag"` -- VM not listed at all because user does not have
                       `triton_cns_enabled` flag set
 - `"user_not_approved"` -- VM not listed at all because user is not
                            approved for provisioning
 - `"inst_en_tag"` -- VM not listed at all because it has the
                      `triton.cns.disable` tag set
 - `"inst_en_flag"` -- VM was removed from services because it has the
                       `triton.cns.status` metadata key set to `down`
 - `"cn_down"` -- VM was removed from services because the CN it runs on
                  seems to be down
 - `"vm_down"` -- VM was removed from services because it is stopped
 - `"invalid_tag"` -- the VM's `triton.cns.services` tag could not be parsed
                      so no services listings are possible

This is not an exhaustive list, but covers the most commonly encountered cases
(due to e.g. forgetting to set the user enabled flag or issues with tags).

### Extra debugging information about replication

When investigating peer sync delays or other problems with replication, the
`cnsadm peers` command can be of use:

```
[root@uuid (dc:cns0) ~]# cnsadm peers 10.0.1.10
address:       10.0.1.10
version:       ISC BIND 9.10.2-P1
using_notify:  true
using_ixfr:    true
serials:
    1.0.10.in-addr.arpa: 373423966
    dc.cns.joyent.us: 373423966

counters:
    soa: 29
    ixfr: 12
    axfr: 4
    goodxfer: 8
```

This can show you whether a given peer is accepting `NOTIFY` commands, whether
it is using `IXFR` (incremental transfers), and counters for errors and types
of queries the peer has made.

The logs of the `cns-server` service can also be informative, as well as the
logs of the peer nameserver itself.

As always, the `dig` command is very useful, particularly with its ability to
request zone transfers (using `dig axfr zone.name @localhost`), which will show
you the entire contents of a given server's version of a zone.

### Rebuilding the CNS redis database

Some past bugs in CNS have caused the Redis database to balloon out to a very
large size (hundreds of MB). The Redis database dump (RDB file) should
generally be on the order of 10MB in size: if the one in your CNS installation
is much larger (e.g. >100MB), you may have been bitten by one of these bugs.

If you have never run a CNS image older than May 2016 on your Triton standup,
and you experience this issue, please report it as a bug! This procedure
may still help you, but the bug needs to be fixed too.

You can check the size of the Redis RDB dump like so:

```
[root@uuid (dc:cns0) ~]# du -hs /data/redis/dump.rdb
3.9M    /data/redis/dump.rdb
```

Thankfully, since CNS is not an authoritative source of any of the data it
serves, it is always possible to simply throw out the Redis database and
re-create from scratch (as if this is the very first time you were running
CNS).

To do this, first stop all the CNS services:

```
[root@uuid (dc:cns0) ~]# svcadm disable cns-server
[root@uuid (dc:cns0) ~]# svcadm disable cns-updater
[root@uuid (dc:cns0) ~]# svcadm disable cns-redis
```

Wait until the Redis server has entirely shut down:

```
[root@uuid (dc:cns0) ~]# svcs -p cns-redis
STATE          STIME    FMRI
online*        22:17:39 svc:/triton/application/cns-redis:default
               22:17:39    89123 redis-server
[root@uuid (dc:cns0) ~]# svcs -p cns-redis
STATE          STIME    FMRI
offline        22:17:39 svc:/triton/application/cns-redis:default
```

Now simply delete the `dump.rdb` file and start `cns-redis` and `cns-updater`
back up again:

```
[root@uuid (dc:cns0) ~]# rm -f /data/redis/dump.rdb
[root@uuid (dc:cns0) ~]# svcadm enable cns-redis
[root@uuid (dc:cns0) ~]# svcadm enable cns-updater
```

While it is safe to start the `cns-server` back up at this point, too, it's not
going to serve anything useful until the `cns-updater` has done its first
update. We can watch the logs of the `cns-updater` to see when this happens:

```
[root@uuid (dc:cns0) ~]# tail -f $(svcs -L cns-updater) | bunyan -o short
...
22:48:36.527Z  INFO cns: Poll done, committing...
22:48:36.560Z DEBUG cns: app state changed to cfRunning
22:48:36.603Z DEBUG cns: pushed 2938 candidates for reaping (stage=ReaperStream)
...
22:48:38.677Z DEBUG cns: reaping complete (stage=ReaperStream)
```

Now we enable the `cns-server` and things should return to normal:

```
[root@uuid (dc:cns0) ~]# svcadm enable cns-server
```
