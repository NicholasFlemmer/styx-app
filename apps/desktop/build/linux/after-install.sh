#!/bin/sh
# Styx .deb post-install: the polkit action that guards production grants (see build/linux/polkit).
set -e
install -D -m 0644 "/opt/Styx/resources/polkit/com.heystyx.styx.policy" \
  /usr/share/polkit-1/actions/com.heystyx.styx.policy
