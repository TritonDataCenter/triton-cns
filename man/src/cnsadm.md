cnsadm 1 "June 2022" cns "CNS Commands"
======================================

NAME
----

cnsadm - administer the Triton CNS

SYNOPSIS
--------

`cnsadm` status

`cnsadm` vm <_uuid_>

`cnsadm` peers

`cnsadm` peers [`-d`] <_address_>

`cnsadm` config

`cnsadm` config [_modifiers_]

`cnsadm` zones

`cnsadm` zones <_zonename_> [_modifiers_]

`cnsadm` zones [`-a`|`-d`] <_zonename_> [_modifiers_]

`cnsadm` upgrade

DESCRIPTION
-----------

The `cnsadm` tool is used to administer the Triton Container Naming Service
(CNS). It gives a simple interface to view and edit CNS' SAPI configuration, as
well as view information about the server's operation.

CNS is a DNS server which automatically generates records based on the contents
of SDC: in particular, it uses information about VMs from VMAPI as well as
`tags` and `metadata` to decide what records to generate, as well as its own
service configuration in SAPI.

DNS has a lot of internal terminology that should be understood before
undertaking any production deployment of this system. In particular, an
understanding of the DNS primary and secondary (sometimes called "master" and
"slave") topology, zone transfers and NOTIFY, as well as zone delegation and
glue records, may prove important in correctly configuring CNS.

There are 3 key modes that CNS can be deployed in:

  `Standalone` mode: is the default mode of operation, where CNS serves
  records as an authoritative nameserver. CNS must be given an external IP
  address and the DNS zones delegated to it by adding NS glue records to their
  parent zone.

  `Primary` mode: functions identically to Standalone mode, except that CNS is
  also configured to allow zone transfers to, and send NOTIFY messages to, some
  set of secondary nameservers. These "peer" nameservers stay in sync with CNS
  using (incremental) zone transfers and serve the same records it does.

  `Hidden Primary` mode (sometimes called "hidden master"): does not require
  CNS to be exposed to clients directly. Instead, a set of peer nameservers
  serve the clients on its behalf after having synchronized the DNS records (
  over some private network) from it using zone transfers. One of the peers is
  designated as the "visible primary" and its name is listed on SOA records in
  the "mname" field as the zone primary, instead of CNS.

In both Standalone and Primary mode, CNS must know a publically-resolvable DNS
name for its own external address. To use these modes, all that is needed from
a clean install is to set this name and then change the name of the default DNS
zone as needed (see *EXAMPLES*, below).

Then, one may add secondary nameservers for Primary mode operation, by adding
them, both to the config option `allow_transfer` and to the list of zone
`peers`.

To use Hidden Primary mode, one must set `hidden_primary` to _true_, as well as
configuring the options listed for Standalone and Primary modes above.

EXAMPLES
--------

Show the current configuration:

    $ cnsadm config
    $ cnsadm zones

Get an overview of the CNS system's current status:

    $ cnsadm status

To set up Standalone or Primary mode, and change the domain being served from the default _dc.sdc.domain_ (based on the information you supplied during SDC setup) to our custom subdomain:

>$ cnsadm config my\_name=_public.hostname.com_ \\
>                 hostmaster=_hostmaster_@_hostname.com_

>$ cnsadm zones dc.sdc.domain zone=_cns.hostname.com_

Add two secondary nameservers:

>$ cnsadm config allow\_transfer+=_192.168.5.2_,_192.168.6.2_

>$ cnsadm zones _cns.hostname.com_ \\
>                peers+=_ns0.hostname.com_,_ns1.hostname.com_

And then change to Hidden Primary mode:

>$ cnsadm zones _cns.hostname.com_ hidden\_primary=true

SUBCOMMANDS
-----------

`cnsadm status`
  Fetches status information about the CNS server and its operation and summarizes it in two tables: a list of zones and when they were last updated, and a list of peers, their names and version and how far behind they currently are.

`cnsadm vm` <_uuid_>
  Displays information CNS has collected about a given SDC VM, including when it was last updated and a list of all names for it that are listed in DNS.

`cnsadm peers` [`-d`] <_address_>
  Shows detailed status information about a CNS peer nameserver. With the `-d` option given, deletes all status information about the peer.

  Peer entries that are no longer in use should be removed as soon as possible so that the garbage collection of incremental change records can take place.

`cnsadm config`
  Displays the current configuration of the CNS system as a whole. Configuration options that are at a per-DNS-zone level can be found under the `cnsadm zones` sub-command.

`cnsadm config` [_modifiers_]
  Alters the configuration of the CNS system. See _MODIFIERS_, below.

`cnsadm zones`
  Displays per-DNS-zone configuration options, summarized in a table listing all known DNS zones.

`cnsadm zones` <_zonename_>
  Displays in detail the per-zone configuration for one DNS zone.

`cnsadm zones` [`-a`|`-d`] <_zonename_> [_modifiers_]
  Alters the per-zone configuration for a given DNS zone. With `-a`, adds a new zone with the given name, or with `-d`, deletes the named zone. No _modifiers_ may be given with the `-d` option.

`cnsadm upgrade`
  Perform any pending upgrade operations. This command should be run after upgrading CNS past any configuration flag-day. It will attempt to convert your configuration to the new format.

MODIFIERS
---------

Some `cnsadm` subcommands such as `cnsadm zones` support _modifiers_ to tell CNS what changes to make to the configuration.

A modifier is a single commandline argument of one of the following forms:

 * _field_`=`_value_
 * _field_`+=`_value_ (only for arrays)
 * _field_`-=`_value_ (only for arrays)

The `=` operator sets the value of the given _field_, entirely replacing any previous value.

The latter two operators `+=` and `-=` are only supported when the named _field_ is of an array type: `+=` adds the given _values_ to the array (a set union) while `-=` removes them (set subtraction).

The valid _values_ depend on the type of the field being altered:

  For `strings` or `numbers`, the _value_ is simply the string value, unquoted.

  For `booleans`, the _value_ must be either `true` or `false`, `yes` or `no`, `on` or `off`.

  For `objects`, the _value_ must be JSON.

  For `arrays`, the _value_ must be a comma-separated list of whatever type the array contains (e.g. an array of booleans could be written as "true,yes,false")

BUGS
----

https://github.com/TritonDataCenter/triton-cns/issues
