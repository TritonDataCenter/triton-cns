---
title: CNS REST API
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

## Ping (GET /ping)

Returns a good (2xx) response code if the CNS server is up and running.

## GetVM (GET /vm/:uuid)

Retrieves the information that CNS has recorded about a given SDC VM, including the DNS records associated with it (both instance and service records).

| Field        | Type              | Description                            |
| ------------ | ----------------- | -------------------------------------- |
| `uuid`       | String            | UUID of the VM, same as in the URL     |
| `names`      | Array of String   | Full DNS names associated with this VM |
| `last_visit` | Integer (JS time) | When CNS last visited this VM          |

Example output:

```json
{
  "uuid": "0abe1901-2c6c-42cb-b5f9-e92d1c8d3c8e",
  "names": [
    "0abe1901-2c6c-42cb-b5f9-e92d1c8d3c8e.inst.930896af-bf8c-48d4-885c-6573a94b1853.coal.cns.joyent.us",
    "0abe1901-2c6c-42cb-b5f9-e92d1c8d3c8e.inst.user.coal.cns.joyent.us",
    "test.inst.930896af-bf8c-48d4-885c-6573a94b1853.coal.cns.joyent.us",
    "test.inst.user.coal.cns.joyent.us"
  ],
  "last_visit": 1453334027000
}
```

## ListPeers (GET /peers)

Lists all the peers of the CNS server (secondary nameservers that have used zone transfers to replicate its contents), including the latest confirmed serial number of each zone that peer has successfully replicated.

| Field        | Type              | Description                            |
| ------------ | ----------------- | -------------------------------------- |
| `address`    | String            | IP address of the peer (IPv4 or IPv6)  |
| `version`    | (Optional) String | Version string for the peer            |
| `serials`    | Object            | Map of zone name => latest serial #    |

Example output:

```json
[
  {
    "address": "127.0.0.1",
    "serials": {
      "coal.cns.joyent.us": 372945319
    },
    "version": "Triton CNS 0.1.0, node v0.12.9"
  },
  {
    "address": "10.99.99.1",
    "serials": {
      "coal.cns.joyent.us": 372711339
    }
  }
]
```

## GetPeer (GET /peer/:address)

Gets detailed information (beyond the information included in ListPeers) about a particular peer. Note that the `address` parameter will be normalized before looking it up, so various IPv6 contractions of the address will all be considered equivalent.

| Field          | Type          | Description                               |
| -------------- | ------------- | ----------------------------------------- |
| `address`      | String        | IP address of the peer (IPv4 or IPv6)     |
| `version`      | (Opt.) String | Version string for the peer               |
| `using_notify` | Boolean       | True if NOTIFY has succeeded              |
| `using_ixfr`   | Boolean       | True if peer is using IXFR (incrementals) |
| `serials`      | Object        | Map of zone name => latest serial #       |
| `counters`     | Object        | Map of name => count, debugging info      |

Example output:

```json
{
  "address": "127.0.0.1",
  "serials": {
    "coal.cns.joyent.us": 372945319
  },
  "version": "Triton CNS 0.1.0, node v0.12.9",
  "using_notify": false,
  "using_ixfr": false,
  "counters": {}
}
```

## DeletePeer (DELETE /peer/:address)

Deletes a peer from CNS, causing all state about the peer (including knowledge about its latest sync'd serial numbers, whether it supports NOTIFY etc) to be forgotten. If the peer continues to attempt to replicate zones after it has been deleted, it will be re-created again as if it is a new peer.

Returns status code `200` upon success.

## ListZones (GET /zones)

Lists all zones served by the CNS server and their latest generated serial numbers.

| Field       | Type       | Description                       |
| ----------- | ---------- | --------------------------------- |
| `name`      | String     | Name of the zone (DNS suffix)     |
| `serial`    | Integer    | Latest available serial number    |

Example output:

```json
[
  {
    "name": "coal.cns.joyent.us",
    "serial": 373005304
  },
  {
    "name": "88.88.10.in-addr.arpa",
    "serial": 373005304
  },
  {
    "name": "99.99.10.in-addr.arpa",
    "serial": 372945319
  }
]
```

## ListAllowedPeers (GET /allowed-peers)

Lists the current contents of the peer ACL. Addresses that match an entry in this ACL will be allowed to perform a zone transfer and become a new peer.

| Field       | Type       | Description                       |
| ----------- | ---------- | --------------------------------- |
| `address`   | String     | IP address (IPv4 or IPv6)         |
| `mask`      | Integer    | Number of bits in subnet mask     |

Example output:

```json
[
  {
    "address": "127.0.0.1",
    "mask": 32
  },
  {
    "address": "::1",
    "mask": 128
  },
  {
    "address": "10.88.88.0",
    "mask": 24
  }
]
```
