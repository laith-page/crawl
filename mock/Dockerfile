# crawlme.fly.dev: faulty's image with the recording beside its document (faulty's deploy/Dockerfile,
# as it says to copy it). PORT=8080 and BIND=0.0.0.0 are the image's; the entrypoint is /faulty, so
# CMD is its arguments. The machine has 512 MB (fly.toml), and the replay must fit with room to spare;
# e2e/mock.spec.ts holds it under 400 MiB, and as deployed:
#   docker run --memory=512m --memory-swap=512m -p 8080:8080 <image>
FROM docker.io/l3io/faulty:0.8.5
COPY crawlme.warc.gz crawlme.json /app/
# faulty's image already runs as its unprivileged user; said again here, where a scanner reads it.
USER 65532:65532
CMD ["/app/crawlme.json"]
