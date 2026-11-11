# All stages run on Linux, even when Docker Desktop is used from Windows.
FROM public.ecr.aws/lambda/nodejs:22 AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY tsconfig.json tsconfig.lambda.json ./
COPY src ./src
RUN npx --no-install tsc -p tsconfig.lambda.json

FROM public.ecr.aws/lambda/nodejs:22 AS production-dependencies
WORKDIR /dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM public.ecr.aws/lambda/nodejs:22 AS runtime
WORKDIR ${LAMBDA_TASK_ROOT}
ENV NODE_ENV=production
COPY --from=production-dependencies /dependencies/node_modules ./node_modules
COPY --from=production-dependencies /dependencies/package.json ./package.json
COPY --from=build /build/dist ./dist
# SAM overrides the command for the worker and status functions.
# Keep the base image's Lambda entrypoint; this is not an Express server image.
CMD ["dist/handlers/submitRecommendation.handler"]
