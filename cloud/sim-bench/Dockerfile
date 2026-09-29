# Runtime image. out/simc is built by build-native.sh inside this same base image, so glibc matches.
FROM node:26-slim
COPY out/simc /usr/local/bin/simc
COPY src/profiles/MID2 /profiles/MID2
COPY runner.mjs /runner.mjs
EXPOSE 8080
CMD ["node", "/runner.mjs"]
