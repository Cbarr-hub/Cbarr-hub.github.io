# Gamertown GMOD-family game container — ONE image for both TTT and Prop Hunt
# (they differ only by env + their named volume). It's a LinuxGSM `gmodserver`
# instance rooted at /data (a named volume): GMOD (appid 4020) + CS:S content
# (appid 232330) install into the volume on first boot, and boot identity
# (GSLT / RCON password / port / gamemode / Workshop collection / default map)
# comes from env. The Docker connectors (backend/src/servers/connectors/docker/
# gmod.js, prophunt.js) drive it with gsmDir=/data, so the layout must match
# LinuxGSM's (./gmodserver, lgsm/, serverfiles/garrysmod, serverfiles/bin/gmad_linux).
#
# Heavy game files live on the volume, NOT in the image, so the image stays small
# and a Prop Hunt instance reuses it with just a different volume + env.
FROM debian:bookworm-slim

# LinuxGSM + SteamCMD runtime deps (srcds is 32-bit, hence i386).
RUN dpkg --add-architecture i386 \
 && apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget file bsdmainutils distro-info distro-info-data lsb-release \
      tar bzip2 gzip unzip xz-utils binutils bc jq tmux netcat-openbsd cpio pigz \
      python3 procps util-linux uuid-runtime iproute2 locales \
      lib32gcc-s1 lib32stdc++6 lib32z1 libsdl2-2.0-0:i386 libtinfo6:i386 libncursesw6:i386 \
 # srcds (GMOD) links libtinfo.so.5, which Debian bookworm replaced with .so.6 —
 # symlink it so the server binary loads (the classic srcds-on-modern-Debian fix).
 && ln -sf /usr/lib/i386-linux-gnu/libtinfo.so.6 /usr/lib/i386-linux-gnu/libtinfo.so.5 \
 && sed -i 's/^# en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen \
 && rm -rf /var/lib/apt/lists/*
ENV LANG=en_US.UTF-8

# LinuxGSM refuses to run as root. /data is the instance root (a mounted volume).
RUN useradd -m -d /data -s /bin/bash linuxgsm
WORKDIR /data

COPY --chown=linuxgsm:linuxgsm docker/gmod/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

# Default game port (overridden per service by PORT env / compose publish).
EXPOSE 27066/tcp 27066/udp

USER linuxgsm
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
