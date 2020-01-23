<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright 2020 Joyent, Inc.
-->

# triton-cns

## 0.2.0

- triton-cns#18 forward zones should always be converted to lower case
- triton-cns#14 always publish names for poseidon
- TRITON-1789 automatically publish names for manta_role
- TRITON-599, TRITON-798 Support multiple ACME challenges and better handling of challenges for new instances
- TRITON-815 support rack aware networking
- TRITON-1044 paginate AXFRs

## 0.1.3

- TRITON-630 cns and cmon content-md5 header incompatible with vmapi for non-ascii characters

## 0.1.2

- TRITON-578 CNS should not continue as though it succeeded in the case of getNapiPools failure

## 0.1.1

- TRITON-519 fix cns service crash when vm does not have an owner_uuid

## 0.1.0

- Lots of things
