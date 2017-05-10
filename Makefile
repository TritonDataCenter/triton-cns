#
# Copyright (c) 2012, Joyent, Inc. All rights reserved.
#
# Makefile: basic Makefile for template API service
#
# This Makefile is a template for new repos. It contains only repo-specific
# logic and uses included makefiles to supply common targets (javascriptlint,
# jsstyle, restdown, etc.), which are used by other repos as well. You may well
# need to rewrite most of this file, but you shouldn't need to touch the
# included makefiles.
#
# If you find yourself adding support for new targets that could be useful for
# other projects too, you should add these to the original versions of the
# included Makefiles (in eng.git) so that other teams can use them too.
#

NAME			:= cns
NODE_PREBUILT_TAG	 = zone
NODE_PREBUILT_VERSION	:= v0.12.9
# This is sdc-minimal-multiarch-lts@15.4.1, compat with
# triton-origin-multiarch-15.4.1.
NODE_PREBUILT_IMAGE=18b094b0-eb01-11e5-80c1-175dac7ddf02

#
# Tools
#
# Get md2man-roff from <https://github.com/sunaku/md2man>
MD2MAN		:= md2man-roff
TAP		:= ./node_modules/.bin/tape
ISTANBUL	:= ./node_modules/.bin/istanbul

#
# Files
#
JS_FILES	:= $(shell find lib test *.js -name '*.js') \
		   bin/cnsadm
JSL_CONF_NODE	 = tools/jsl.node.conf
JSL_FILES_NODE   = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSSTYLE_FLAGS    = -f tools/jsstyle.conf

SMF_MANIFESTS_IN = smf/manifests/cns-server.xml.in \
		   smf/manifests/cns-updater.xml.in \
		   smf/manifests/cns-redis.xml.in

MAN_PAGES       := $(shell ls man/src)
MAN_OUTDIR      := man/man1
MAN_OUTPAGES=$(MAN_PAGES:%.md=$(MAN_OUTDIR)/%.1)
MAN_ROOT        := man/src

DOC_FILES	 = index.md metadata.md operator-guide.md

include ./tools/mk/Makefile.defs
ifeq ($(shell uname -s),SunOS)
        include ./tools/mk/Makefile.node_prebuilt.defs
else
        include ./tools/mk/Makefile.node.defs
endif
include ./tools/mk/Makefile.node_deps.defs
include ./tools/mk/Makefile.smf.defs

RELEASE_TARBALL	:= $(NAME)-pkg-$(STAMP).tar.bz2
RELSTAGEDIR     := /tmp/$(STAMP)

#
# Repo-specific targets
#
.PHONY: all
all: $(REPO_DEPS) $(NPM_EXEC)
	$(NPM) install

CLEAN_FILES += $(TAP) ./node_modules/tape

$(TAP): all

.PHONY: test
test: all $(TAP) $(NODE_EXEC)
	TAP=1 $(NODE) $(TAP) test/unit/*.test.js

$(ISTANBUL): $(NPM_EXEC)
	$(NPM) install istanbul

.PHONY: coverage
coverage: all $(ISTANBUL) $(NODE_EXEC)
	$(NODE) $(ISTANBUL) cover \
	    $(TAP) test/*.test.js

.PHONY: release
release: all docs $(SMF_MANIFESTS) $(NODE_EXEC)
	@echo "Building $(RELEASE_TARBALL)"
	@mkdir -p $(RELSTAGEDIR)/root/opt/triton/cns
	@mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/boot
	@mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/build
	@mkdir -p $(RELSTAGEDIR)/site
	@touch $(RELSTAGEDIR)/site/.do-not-delete-me
	cp -r   $(TOP)/boot \
		$(TOP)/bin \
		$(TOP)/man \
		$(TOP)/lib \
		$(TOP)/node_modules \
		$(TOP)/package.json \
		$(TOP)/sapi_manifests \
		$(TOP)/{server,updater}.js \
		$(TOP)/test \
		$(TOP)/smf \
		$(TOP)/etc \
		$(RELSTAGEDIR)/root/opt/triton/cns/
	@mkdir -p $(RELSTAGEDIR)/root/opt/triton/cns/build
	cp -r   $(TOP)/build/node \
		$(RELSTAGEDIR)/root/opt/triton/cns/build/
	cp -R $(TOP)/node_modules/sdc-scripts/* $(RELSTAGEDIR)/root/opt/smartdc/boot/
	@mkdir -p $(RELSTAGEDIR)/root/opt/local/bin
	cp $(TOP)/bin/cmd-wrapper $(RELSTAGEDIR)/root/opt/local/bin/cnsadm
	cp -r $(TOP)/man $(RELSTAGEDIR)/root/opt/local/
	cp -R $(TOP)/boot/* $(RELSTAGEDIR)/root/opt/smartdc/boot/
	(cd $(RELSTAGEDIR) && $(TAR) -jcf $(TOP)/$(RELEASE_TARBALL) root site)
	@rm -rf $(RELSTAGEDIR)

.PHONY: publish
publish: release
	@if [[ -z "$(BITS_DIR)" ]]; then \
		echo "error: 'BITS_DIR' must be set for 'publish' target"; \
		exit 1; \
	fi
	mkdir -p $(BITS_DIR)/cns
	cp $(TOP)/$(RELEASE_TARBALL) $(BITS_DIR)/cns/$(RELEASE_TARBALL)

$(MAN_OUTDIR):
	mkdir -p $@

$(MAN_OUTDIR)/%.1: $(MAN_ROOT)/%.md | $(MAN_OUTDIR)
	$(MD2MAN) $^ > $@

.PHONY: manpages
manpages: $(MAN_OUTPAGES)

include ./tools/mk/Makefile.deps
ifeq ($(shell uname -s),SunOS)
        include ./tools/mk/Makefile.node_prebuilt.targ
else
        include ./tools/mk/Makefile.node.targ
endif
include ./tools/mk/Makefile.smf.targ
include ./tools/mk/Makefile.node_deps.targ
include ./tools/mk/Makefile.targ
