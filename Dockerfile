# syntax=docker/dockerfile:1.7
#
# hyde-mcp-gateway's image. .github/workflows/deploy.yml builds it and pushes it to
# the registry infra/base.yaml names.
#
# --platform is pinned: Scaleway Serverless Containers run amd64 only and
# reject anything else at deploy time, which is what a default build on an
# Apple Silicon Mac produces.
FROM --platform=linux/amd64 node:24-slim
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable

# The whole tree, not just package.json: a pnpm workspace (packages/) needs
# its members' manifests to install from the root lockfile. .dockerignore
# keeps node_modules, apply.env and .env* out of the context.
#
# The tree includes schemas/, which is not committed: `pnpm schemas` (log field
# schemas) and `pnpm fetch:redacted-schemas` (redacted-schema.md) fill it from
# the app repos' main before the build (deploy.yml; README, First deploy). The
# server reads it at startup. Without it every log field would be hidden and
# describe_schema would fail, so the build stops here instead.
COPY . .
RUN for f in schemas/crm.hyde-json.json schemas/shop.hyde-json.json \
             schemas/crm.redacted-schema.md schemas/shop.redacted-schema.md; do \
      test -s "$f" || { echo "$f is missing: run pnpm schemas and pnpm fetch:redacted-schemas before docker build" >&2; exit 1; }; \
    done
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod

USER node
# src/config.ts reads PORT; infra/base.yaml `container.port` is the same.
ENV PORT=8080
EXPOSE 8080
# Node runs the TypeScript sources directly (type stripping); there is no build.
CMD ["node", "src/mcp/main.ts"]
