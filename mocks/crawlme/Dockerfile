# syntax=docker/dockerfile:1
# crawlme.fly.dev: faulty's image with the recording beside its document (faulty's deploy/Dockerfile, as it says to
# copy it). PORT=8080 and BIND=0.0.0.0 are the image's; the entrypoint is /faulty, so CMD is its arguments. The
# machine has 512 MB (fly.toml), and the replay must fit with room to spare; e2e/mocks.test.ts holds it under
# 400 MiB, and as deployed:
#   docker run --memory=512m --memory-swap=512m -p 8080:8080 <image>
# GET /health answers once faulty listens; GET /version answers the BUILD_COMMIT the image was built with: l3 deploy
# passes the key of this folder (`mock-<key>`), not the commit, and deploys the mock only when that key is not served.

# The document with the key in its /version answer.
FROM docker.io/library/busybox:1.37 AS document
ARG BUILD_COMMIT=dev
COPY crawlme.json /app/crawlme.json
RUN sed -i "s/\"commit\": \"dev\"/\"commit\": \"${BUILD_COMMIT}\"/" /app/crawlme.json && grep -q "\"commit\": \"${BUILD_COMMIT}\"" /app/crawlme.json

FROM docker.io/l3io/faulty:0.8.14
# /app made by copying the document's directory first: BuildKit gives a directory an ADD --chmod creates that mode too,
# and /app at 644 (no search bit) left faulty's user unable to open its document ("permission denied").
COPY --from=document /app/ /app/
# The recording, as fixtures.json pins it.
ADD --chmod=644 --checksum=sha256:814ebcc4b319748421894ebc09d5dce17043eeac85b907cf991074681fed5c15 https://warc.l3.ai/crawlme.warc.gz /app/crawlme.warc.gz
# faulty's image already runs as its unprivileged user; said again here, where a scanner reads it.
USER 65532:65532
CMD ["/app/crawlme.json"]
