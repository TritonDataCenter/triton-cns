<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright 2019 Joyent, Inc.
-->

# triton-cns

This repository is part of the Joyent Triton project. See the [contribution
guidelines](https://github.com/joyent/triton/blob/master/CONTRIBUTING.md)
and general documentation at the main
[Triton project](https://github.com/joyent/triton) page.

The Triton CNS (Container Naming Service) generates and serves DNS records
based on the VMs and metadata configured in Triton.

# Installation

Installation, configuration and control of CNS:

* [Operator Guide](docs/operator-guide.md)
* [Metadata Controls](docs/metadata.md)

# API

See the [REST API](docs/index.md) for communicating with CNS.

# Usage in Triton

This blog post details how to use CNS to connect containers within a Triton DC:

https://docs.joyent.com/public-cloud/network/cns/usage
