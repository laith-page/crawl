# syntax=docker/dockerfile:1
# The image (`publish: ["image"]`): the jar on a runtime jlinked from JDK 27 with its AOT cache, on distroless, for
# x86-64 and ARM64, each built natively on a runner of its own architecture (`l3 deploy --image <platform>`).
#
# Built FROM what was built outside it: l3 makes target/crawler.jar on the runner first (`mvn package`, the job's
# Maven cache; the commit -V names is the job's BUILD_COMMIT), and the image copies it in (.dockerignore lets in
# that, jvm.options and the training's document alone). l3 builds it on a BuildKit builder whose layers are cached
# in the registry (l3io/crawl:buildcache-<arch>): what depends on the base and the pins alone (apt, the JDK, jlink,
# the glibc rootfs, the training's mock) comes CACHED, and a push builds the jar's few layers. The JDK is checked
# against its published sum, fetched through the org's download mirror first.

FROM debian:13-slim AS runtime
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates tar gzip binutils && rm -rf /var/lib/apt/lists/*
ENV JAVA_HOME=/opt/jdk-27
RUN mkdir -p ${JAVA_HOME} && \
    base=https://download.java.net/java/GA/jdk27/55ce5470a6294008af0057ff4626d0e5/35/GPL && \
    case "$(uname -m)" in \
        x86_64) file=openjdk-27_linux-x64_bin.tar.gz sum=95fc37eb3a18a27a26d5904c2d89d52bace8dafa9a078ca27f4747fbc4bf070b ;; \
        aarch64) file=openjdk-27_linux-aarch64_bin.tar.gz sum=da4e9dde1fff90204739e969187bab4751bd59a2a1c479672e1a1810f7dd23ea ;; \
        *) echo "no JDK for $(uname -m)" >&2; exit 1 ;; esac && \
    { curl -fsSL --retry 2 --retry-all-errors -o /tmp/jdk.tar.gz "https://cache.l3.ai/mirror/download.java.net${base#https://download.java.net}/$file" || \
      curl -fsSL --retry 5 --retry-all-errors -o /tmp/jdk.tar.gz "$base/$file"; } && \
    echo "$sum  /tmp/jdk.tar.gz" | sha256sum -c - && \
    tar -xzf /tmp/jdk.tar.gz -C ${JAVA_HOME} --strip-components=1 && rm /tmp/jdk.tar.gz
ENV PATH="${JAVA_HOME}/bin:${PATH}"
WORKDIR /build

# A trimmed runtime: the modules the app needs (src/main/jvm.options' --add-modules). No jimage compression: the registry
# gzips layers, and a plain image gzips smaller than a zip-6 one besides loading classes faster.
RUN jlink --add-modules java.base,jdk.unsupported --strip-debug --no-man-pages --no-header-files --output /opt/jre
# Symbols the JVM never needs, and files a runtime without a shell never uses. conf/security/policy
# stays: JceSecurity requires the crypto policies.
RUN strip --strip-unneeded /opt/jre/lib/server/libjvm.so /opt/jre/lib/*.so 2>/dev/null || true
RUN rm -rf /opt/jre/legal /opt/jre/bin/keytool /opt/jre/lib/jrt-fs.jar /opt/jre/lib/classlist \
           /opt/jre/lib/jexec /opt/jre/lib/jspawnhelper /opt/jre/lib/security/blocked.certs \
           /opt/jre/lib/libjsig.so /opt/jre/lib/server/libjsig.so

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

# The training's site, on this machine: crawlme's own mock (faulty at its image's pin, serving the recording of
# crawlme.fly.dev that fixtures.json pins), over TLS with the authority it makes. No network is crawled: a crawl of the
# live crawlme.fly.dev at the default one request a second took 98 s of each build.
COPY --from=docker.io/l3io/faulty:0.8.14 /faulty /usr/local/bin/faulty
ADD --checksum=sha256:814ebcc4b319748421894ebc09d5dce17043eeac85b907cf991074681fed5c15 https://warc.l3.ai/crawlme.warc.gz /train/crawlme.warc.gz
COPY mocks/crawlme/crawlme.json /train/crawlme.json

# The flags the app ships with: src/main/jvm.options, one a line, less its comments and --add-modules. The entrypoint
# reads them from an @argfile, the cache added; the training runs get them through JAVA_TOOL_OPTIONS.
COPY src/main/jvm.options /opt/jvm.options
RUN sed -e 's/#.*//' -e 's/[[:space:]]*$//' -e '/^$/d' -e '/^--add-modules/d' /opt/jvm.options > /opt/crawler.flags && \
    { cat /opt/crawler.flags; echo "-XX:AOTCache=/opt/crawler.aot"; } > /opt/crawler.options
ENV AOT_RECORD="-XX:+UnlockDiagnosticVMOptions -XX:+UnlockExperimentalVMOptions -XX:+AOTClassLinking -XX:+AOTInvokeDynamicLinking -XX:AOTCodeMaxSize=67108864 -XX:AOTMode=record -XX:AOTConfiguration=/opt/crawler.aotconfig"
ENV AOT_CREATE="-XX:+UnlockDiagnosticVMOptions -XX:+UnlockExperimentalVMOptions -XX:+AOTClassLinking -XX:+AOTInvokeDynamicLinking -XX:AOTCodeMaxSize=67108864 -XX:AOTMode=create -XX:+AOTCompileEagerly -XX:AOTConfiguration=/opt/crawler.aotconfig -XX:AOTCache=/opt/crawler.aot"

# The jar, built by l3 before the image: what changes with the sources, last.
COPY target/crawler.jar target/crawler.jar

# The AOT cache's training: the crawl train/ trains with (-f -c 64 -n 2000), of the recording over TLS, a second or two.
RUN set -e; \
    faulty --port 18080 --tls /train/crawlme.json > /tmp/faulty.log 2>&1 & mock=$!; \
    for i in $(seq 1 100); do curl -fsS -o /train/ca.pem http://127.0.0.1:18080/__faulty/ca.pem 2>/dev/null && break; sleep 0.1; done; \
    [ -s /train/ca.pem ] || { cat /tmp/faulty.log >&2; exit 1; }; \
    SSL_CERT_FILE=/train/ca.pem JAVA_TOOL_OPTIONS="$(tr '\n' ' ' < /opt/crawler.flags) $AOT_RECORD" \
        /opt/jre/bin/java -Xms64m -Xmx256m -jar target/crawler.jar -f -c 64 -n 2000 https://localhost:18080/ > /dev/null; \
    kill "$mock" 2>/dev/null || true

# Assemble the cache from the recording; main does not run.
RUN JAVA_TOOL_OPTIONS="$(tr '\n' ' ' < /opt/crawler.flags) $AOT_CREATE" /opt/jre/bin/java -jar target/crawler.jar && \
    rm -f /opt/crawler.aotconfig

# World-readable, for the unprivileged user the container runs as.
RUN chmod -R a+rX /opt/jre /opt/crawler.aot /opt/crawler.options target/crawler.jar

# ---- The image ---------------------------------------------------------------------------------
FROM gcr.io/distroless/static-debian12:nonroot AS final
COPY --from=runtime /rootfs/ /
COPY --from=runtime /opt/jre /opt/jre
COPY --from=runtime /build/target/crawler.jar /opt/crawler.jar
COPY --from=runtime /opt/crawler.aot /opt/crawler.aot
COPY --from=runtime /opt/crawler.options /opt/crawler.options

# The commit the image was built from (l3 passes BUILD_COMMIT): a label, no layer.
ARG BUILD_COMMIT=dev
LABEL org.opencontainers.image.revision=${BUILD_COMMIT}
# The unprivileged user, said explicitly, so a scanner can see it.
USER 65532:65532
ENTRYPOINT ["/opt/jre/bin/java", "@/opt/crawler.options", "-jar", "/opt/crawler.jar"]
CMD ["-h"]
