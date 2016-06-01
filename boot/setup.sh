#!/bin/bash
# -*- mode: shell-script; fill-column: 80; -*-
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
#

export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
set -o xtrace

SOURCE="${BASH_SOURCE[0]}"
if [[ -h $SOURCE ]]; then
    SOURCE="$(readlink "$SOURCE")"
fi
DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"
SVC_ROOT=/opt/triton/cns
DATA_ROOT=/data

TCNS_CFG=$SVC_ROOT/etc/config.json
ZONE_UUID=`/usr/bin/zonename`
ZONE_DATASET=zones/$ZONE_UUID/data

export PATH=$SVC_ROOT/build/node/bin:/opt/local/bin:/usr/sbin/:/usr/bin:$PATH

mkdir -p $DATA_ROOT
zfs list $ZONE_DATASET && rc=$? || rc=$?
if [[ $rc == 0 ]]; then
    mountpoint=$(zfs get -H -o value mountpoint $ZONE_DATASET)
    if [[ $mountpoint != $DATA_ROOT ]]; then
        zfs set mountpoint=$DATA_ROOT $ZONE_DATASET || \
            fatal "failed to set mountpoint"
    fi
fi
chmod 777 $DATA_ROOT
mkdir -p $DATA_ROOT/redis
chmod 777 $DATA_ROOT/redis

function sdc_setup_redis {
    sdc_log_rotation_add amon-agent /var/svc/log/*amon-agent*.log 1g
    sdc_log_rotation_add config-agent /var/svc/log/*config-agent*.log 1g
    sdc_log_rotation_add redis /var/log/redis/*redis*.log 1g
    sdc_log_rotation_setup_end

    svccfg import $SVC_ROOT/smf/manifests/cns-redis.xml
    svcadm enable redis
}

CONFIG_AGENT_LOCAL_MANIFESTS_DIRS=$SVC_ROOT

# Include common utility functions (then run the boilerplate)
source /opt/smartdc/boot/lib/util.sh
sdc_common_setup

echo "Adding CNS user"
useradd -d /opt/triton/cns -P 'Metadata Reader' cns

echo "Installing cns redis"
sdc_setup_redis

# set up services
svccfg import $SVC_ROOT/smf/manifests/cns-server.xml
svccfg import $SVC_ROOT/smf/manifests/cns-updater.xml
svcadm enable cns-server
svcadm enable cns-updater

# add log rotation entries for services
sdc_log_rotation_add cns-updater /var/svc/log/*cns-updater*.log 1g
sdc_log_rotation_add cns-server /var/svc/log/*cns-server*.log 1g

# All done, run boilerplate end-of-setup
sdc_setup_complete


exit 0
