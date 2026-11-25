FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

# CRITICAL: tailwind.config.js + postcss.config.js MUST be inside the image
# or PostCSS falls back to Tailwind's built-in empty default config, which
# generates zero utility classes — every `flex`, `w-10`, `rounded-2xl` in
# the source becomes a dead string. Only `@layer components` classes that
# use `@apply` would continue to work, which masks the bug.
COPY vite.config.ts tsconfig.json index.html tailwind.config.js postcss.config.js ./
COPY src ./src

EXPOSE 5173
CMD ["npm", "run", "dev"]
