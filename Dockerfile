# syntax=docker/dockerfile:1
# Written by tools (mise run dockerfile) from project.ts's ship.java and ship.image; the gate fails while it
# differs from what they make, so change them, not this file.
# The docker.io/l3io/crawl:latest image: the jar on a runtime jlinked from JDK 27 with its AOT cache, on
# distroless, for x86-64 and ARM64. Built from pom.xml and src alone (.dockerignore).
#
# The jar is the same on every architecture, so Maven runs once, on the platform doing the build;
# only the stages that make native things (jlink, the AOT cache, the glibc rootfs) run under
# emulation for the other architecture. The JDK and Maven are checked against their published sums.

# ---- The jar, once ----------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM debian:13-slim AS jar
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates tar gzip && rm -rf /var/lib/apt/lists/*
ENV JAVA_HOME=/opt/jdk-27 MAVEN_HOME=/opt/maven
RUN mkdir -p ${JAVA_HOME} ${MAVEN_HOME} && \
    case "$(uname -m)" in \
        x86_64) url=https://download.java.net/java/GA/jdk27/55ce5470a6294008af0057ff4626d0e5/35/GPL/openjdk-27_linux-x64_bin.tar.gz sum=95fc37eb3a18a27a26d5904c2d89d52bace8dafa9a078ca27f4747fbc4bf070b ;; \
        aarch64) url=https://download.java.net/java/GA/jdk27/55ce5470a6294008af0057ff4626d0e5/35/GPL/openjdk-27_linux-aarch64_bin.tar.gz sum=da4e9dde1fff90204739e969187bab4751bd59a2a1c479672e1a1810f7dd23ea ;; \
        *) echo "no JDK for $(uname -m)" >&2; exit 1 ;; esac && \
    curl -fsSL --retry 5 --retry-all-errors -o /tmp/jdk.tar.gz "$url" && \
    echo "$sum  /tmp/jdk.tar.gz" | sha256sum -c - && \
    tar -xzf /tmp/jdk.tar.gz -C ${JAVA_HOME} --strip-components=1 && rm /tmp/jdk.tar.gz && \
    curl -fsSL --retry 5 --retry-all-errors -o /tmp/maven.tar.gz https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.16/apache-maven-3.9.16-bin.tar.gz && \
    echo "831a8591fe20c8243b1dbe7d71e3244f31d1665b0804b2e825e38cbbe5ce0cafb8338851f90780735568773e0a6cd07bbec107cda0b896b008b861075358b6f6  /tmp/maven.tar.gz" | sha512sum -c - && \
    tar -xzf /tmp/maven.tar.gz -C ${MAVEN_HOME} --strip-components=1 && rm /tmp/maven.tar.gz
ENV PATH="${JAVA_HOME}/bin:${MAVEN_HOME}/bin:${PATH}"
WORKDIR /build
COPY pom.xml ./
RUN --mount=type=cache,target=/root/.m2 mvn -B -ntp dependency:go-offline || true
COPY src ./src
RUN --mount=type=cache,target=/root/.m2 mvn -B -ntp -DskipTests package

# ---- The runtime, per architecture ------------------------------------------------------------
FROM debian:13-slim AS runtime
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates tar gzip binutils && rm -rf /var/lib/apt/lists/*
ENV JAVA_HOME=/opt/jdk-27
RUN mkdir -p ${JAVA_HOME} && \
    case "$(uname -m)" in \
        x86_64) url=https://download.java.net/java/GA/jdk27/55ce5470a6294008af0057ff4626d0e5/35/GPL/openjdk-27_linux-x64_bin.tar.gz sum=95fc37eb3a18a27a26d5904c2d89d52bace8dafa9a078ca27f4747fbc4bf070b ;; \
        aarch64) url=https://download.java.net/java/GA/jdk27/55ce5470a6294008af0057ff4626d0e5/35/GPL/openjdk-27_linux-aarch64_bin.tar.gz sum=da4e9dde1fff90204739e969187bab4751bd59a2a1c479672e1a1810f7dd23ea ;; \
        *) echo "no JDK for $(uname -m)" >&2; exit 1 ;; esac && \
    curl -fsSL --retry 5 --retry-all-errors -o /tmp/jdk.tar.gz "$url" && \
    echo "$sum  /tmp/jdk.tar.gz" | sha256sum -c - && \
    tar -xzf /tmp/jdk.tar.gz -C ${JAVA_HOME} --strip-components=1 && rm /tmp/jdk.tar.gz
ENV PATH="${JAVA_HOME}/bin:${PATH}"
WORKDIR /build

# A trimmed runtime: the modules the app needs (ship.java.modules). No jimage compression: the registry
# gzips layers, and a plain image gzips smaller than a zip-6 one besides loading classes faster.
# The jar after the runtime: these layers depend on the JDK alone, so a change to the app rebuilds none of
# them (under QEMU for arm64, a minute each) while the builder's cache holds them.
RUN jlink --add-modules java.base,jdk.unsupported --strip-debug --no-man-pages --no-header-files --output /opt/jre
# Symbols the JVM never needs, and files a runtime without a shell never uses. conf/security/policy
# stays: JceSecurity requires the crypto policies.
RUN strip --strip-unneeded /opt/jre/lib/server/libjvm.so /opt/jre/lib/*.so 2>/dev/null || true
RUN rm -rf /opt/jre/legal /opt/jre/bin/keytool /opt/jre/lib/jrt-fs.jar /opt/jre/lib/classlist \
           /opt/jre/lib/jexec /opt/jre/lib/jspawnhelper /opt/jre/lib/security/blocked.certs \
           /opt/jre/lib/libjsig.so /opt/jre/lib/server/libjsig.so
COPY --from=jar /build/target/crawler.jar target/crawler.jar

# The flags the app ships with (ship.java.flags). The entrypoint reads them from an @argfile, the cache
# added; the training runs get them through JAVA_TOOL_OPTIONS, as tools trains.
ENV FLAGS="-XX:MaxRAMPercentage=75 -Xlog:disable -Xlog:all=warning,gc+ergo=error:stderr --enable-native-access=ALL-UNNAMED -XX:+UnlockDiagnosticVMOptions -XX:+UseSerialGC -XX:+UseCompressedOops -XX:-UsePerfData -XX:CICompilerCount=2 -XX:UserThreadWaitAttemptsAtExit=0 -Djava.util.concurrent.ForkJoinPool.common.parallelism=0 -Djdk.readPollers=1 -Xmn64m -Djdk.tls.namedGroups=x25519,secp256r1"
ENV AOT_RECORD="-XX:+UnlockDiagnosticVMOptions -XX:+UnlockExperimentalVMOptions -XX:+AOTClassLinking -XX:+AOTInvokeDynamicLinking -XX:AOTCodeMaxSize=67108864 -XX:AOTMode=record -XX:AOTConfiguration=/opt/crawler.aotconfig"
ENV AOT_CREATE="-XX:+UnlockDiagnosticVMOptions -XX:+UnlockExperimentalVMOptions -XX:+AOTClassLinking -XX:+AOTInvokeDynamicLinking -XX:AOTCodeMaxSize=67108864 -XX:AOTMode=create -XX:+AOTCompileEagerly -XX:AOTConfiguration=/opt/crawler.aotconfig -XX:AOTCache=/opt/crawler.aot"
RUN printf '%s\n' $FLAGS -XX:AOTCache=/opt/crawler.aot > /opt/crawler.options

# The AOT cache's training (ship.image.dockerfile.train): each run in turn until one succeeds.
RUN JAVA_TOOL_OPTIONS="$FLAGS $AOT_RECORD" /opt/jre/bin/java -Xms64m -Xmx256m -jar target/crawler.jar -n 100 https://crawlme.fly.dev/ || \
    JAVA_TOOL_OPTIONS="$FLAGS $AOT_RECORD" /opt/jre/bin/java -Xms64m -Xmx256m -jar target/crawler.jar -h

# Assemble the cache from the recording; main does not run.
RUN JAVA_TOOL_OPTIONS="$FLAGS $AOT_CREATE" /opt/jre/bin/java -jar target/crawler.jar && \
    rm -f /opt/crawler.aotconfig

# World-readable, for the unprivileged user the container runs as.
RUN chmod -R a+rX /opt/jre /opt/crawler.aot /opt/crawler.options target/crawler.jar

# The least glibc the JVM needs (~3.2 MB), at the architecture's own library path and dynamic loader.
RUN libdir="/lib/$(uname -m)-linux-gnu" && \
    case "$(uname -m)" in x86_64) loader=/lib64/ld-linux-x86-64.so.2 ;; aarch64) loader=/lib/ld-linux-aarch64.so.1 ;; esac && \
    mkdir -p "/rootfs$libdir" "/rootfs$(dirname "$loader")" && \
    cp "$loader" "/rootfs$loader" && \
    for lib in libc.so.6 libm.so.6 libdl.so.2 libpthread.so.0 librt.so.1 libresolv.so.2 libnss_dns.so.2 libnss_files.so.2; do \
        cp "$libdir/$lib" "/rootfs$libdir/"; done && \
    cp "$libdir"/libz.so.1* "/rootfs$libdir/" && \
    cp "$libdir"/ld-linux-*.so.* "/rootfs$libdir/" 2>/dev/null || true && \
    strip --strip-unneeded "/rootfs$libdir"/*.so* 2>/dev/null || true

# ---- The image ---------------------------------------------------------------------------------
FROM gcr.io/distroless/static-debian12:nonroot AS final
COPY --from=runtime /rootfs/ /
COPY --from=runtime /opt/jre /opt/jre
COPY --from=runtime /build/target/crawler.jar /opt/crawler.jar
COPY --from=runtime /opt/crawler.aot /opt/crawler.aot
COPY --from=runtime /opt/crawler.options /opt/crawler.options

# The unprivileged user, said explicitly, so a scanner can see it.
USER 65532:65532
ENTRYPOINT ["/opt/jre/bin/java", "@/opt/crawler.options", "-jar", "/opt/crawler.jar"]
CMD ["-h"]
