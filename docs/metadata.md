---
title: CNS metadata reference
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

## UFDS properties

### `triton_cns_enabled`

This can be set on an Account, and indicates whether an account is enabled for
Triton CNS or not.

Possible values:
 - `"true"` (String value)
 - `"false"` (String value)

Note that UFDS cannot store typed values in unindexed fields, so even though
conceptually this is a boolean, UFDS stores it as a string.

## Instance tags (VMAPI)

### `triton.cns.disable`

If this tag is set to a value that is not `false` or `"false"`, then the VM
will not be listed in any form in CNS. This tag overrules all other tags
and settings.

Possible values:
 - `false` (Boolean)
 - `"false"` (String)
 - Any other value (will be considered to mean "disable this VM")

### `triton.cns.services`

This tag must have a string value, which determines which service records this
VM will be listed under and in what form.

The format is as follows (in
[PEG](https://en.wikipedia.org/wiki/Parsing_expression_grammar) notation):

```
service ( "," service )*
```

Where:

```
service   := dns-label ( ":" port )? ( ":" key "=" value )*
dns-label := [a-z] [a-z0-9-]*          # <= 63 chars in length
port      := [0-9]+                    # 0 < N < 65536
key       := [a-z] [a-z0-9-]*
value     := [^,:]+
```

The `dns-label` is the key detail, which forms the first label in the DNS name
of the service that this instance will be a member of.

Declaring the same service label multiple times within one tag is acceptable:
for A, AAAA and TXT records, this will not result in duplicate listings. For
SRV records, there will be one record in DNS per unique `label`-`port`
combination.

If multiple key-value arguments are given with the same `key`, the last one
present will overrule the value of any previous.

Instead of using the numeric port as the second `:` separated component, it
is also acceptable to use a key-value argument of `port=N`. If both are given,
the last `port=N` will be used.

Example values:
 - `foo` -- lists the instance as a member of a single service named `foo`. No
   SRV records are generated.
 - `foo:1234` -- lists the instance as a member of a service named `foo`,
   generating an SRV record for port `1234`.
 - `foo,bar` -- lists the instance as a member of two services, `foo` and `bar`
 - `foo:1234,foo:1235,bar` -- lists the instance as a member of two services,
   `foo` and `bar`. For `foo`, SRV records will be generated for ports `1234`
   and `1235`. For `bar`, no SRV record will be generated.
 - `foo:port=1234` -- same as `foo:1234`
 - `foo:1234:priority=20` -- lists the instance as a member of a service named
   `foo`, and generates an SRV record for port `1234` with its priority field
   set to `20`.
 - `foo:1234:priority=20:weight=20` -- as above, with the weight field also set
   to `20`.
 - `foo:1234:priority=20,bar:1235` -- member of two services, `foo` and `bar`,
   `foo` will generate an SRV with port `1234` and priority `20`, `bar` will
   generate an SRV record with port `1235`.

### `triton.cns.reverse_ptr`

This tag may have a string value, which determines the reverse lookup (PTR)
name to be listed for this instance's IP addresses. Setting this tag will
change the reverse lookup for the addresses of all of the instance's NICs,
regardless of what network they are on -- however, not all such addresses
may actually have their reverse lookup records published in accessible DNS
(e.g. for private RFC1918 addresses).

Possible values:
 - Any valid DNS name (`[a-z] [a-z0-9-]+ ( "." [a-z0-9-]+ )*` up to 63
   characters per label, and up to 255 characters total)

Note that if this tag is set on an instance, it will overrule the
`triton_cns_enabled` tag for the owner, and force this VM to be listed in
CNS. The `triton.cns.disable` tag can overrule this.

Example values:
 - `mail.something.com` -- will cause reverse lookups for any of this
   instance's IP addresses to return `mail.something.com`, useful for
   an SMTP server

## Instance metadata (VMAPI)

### `triton.cns.status`

Can be set to "quiesce" an instance in a service -- remove it from DNS in
advance of some planned outage (e.g. for maintenance) so that there is no
impact on new incoming traffic.

If this metadata key's value is set to `"down"`, then the instance will be
removed from any service records in CNS. Its instance record will remain
unchanged.

Possible values:
 - `"down"` (String)
 - `"up"` (String)
 - Any other string value (will be considered the same as `"up"`)

### `triton.cns.acme-challenge`

Can be set to publish data in a TXT record under `_acme-challenge.$name` for
all DNS names for this instance.

Used with the ACME certificate issuance protocol, to prove ownership of a
particular domain.

Possible values:
 - Any URL-safe base64 string
