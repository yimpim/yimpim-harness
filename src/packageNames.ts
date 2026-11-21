/**
 * A package name that is one or two keystrokes from a very popular one ("expresss", "reqeusts") is how a typosquat gets installed. The registry's own facts cannot say so (the
 * look-alike exists, and may have been published yesterday), so the name is compared with the names people actually mean. A hit is never cleared by a model: a person decides.
 */

/** The names most often meant in each ecosystem. Not complete; enough that a one-letter slip on one of them is caught. */
const NPM_TOP = [
  "react", "react-dom", "react-native", "expo", "next", "vue", "angular", "svelte", "express", "koa", "fastify", "lodash", "underscore", "axios", "moment", "dayjs", "date-fns", "uuid",
  "typescript", "webpack", "vite", "rollup", "esbuild", "babel", "eslint", "prettier", "jest", "mocha", "chai", "vitest", "cypress", "playwright", "puppeteer", "supertest",
  "chalk", "commander", "yargs", "inquirer", "dotenv", "cors", "body-parser", "cookie-parser", "helmet", "morgan", "passport", "jsonwebtoken", "bcrypt", "bcryptjs", "mongoose",
  "mongodb", "mysql", "mysql2", "pg", "sqlite3", "redis", "ioredis", "sequelize", "typeorm", "prisma", "knex", "graphql", "apollo-server", "socket.io", "ws", "nodemon", "rimraf",
  "glob", "minimist", "semver", "request", "node-fetch", "cross-env", "debug", "async", "bluebird", "rxjs", "redux", "react-redux", "zustand", "mobx", "immer", "formik", "yup", "zod",
  "tailwindcss", "postcss", "autoprefixer", "sass", "styled-components", "emotion", "classnames", "framer-motion", "three", "d3", "chart.js", "recharts", "react-router", "react-router-dom",
  "react-query", "swr", "expo-router", "expo-sqlite", "expo-camera", "expo-notifications", "expo-constants", "expo-font", "react-navigation", "firebase", "stripe", "aws-sdk", "nodemailer",
  "multer", "sharp", "jimp", "cheerio", "marked", "highlight.js", "prop-types", "core-js", "tslib", "ts-node", "tsx", "husky", "lint-staged", "concurrently", "left-pad", "colors", "faker",
];
const PYPI_TOP = [
  "requests", "numpy", "pandas", "scipy", "matplotlib", "seaborn", "scikit-learn", "tensorflow", "torch", "keras", "flask", "django", "fastapi", "uvicorn", "gunicorn", "sqlalchemy",
  "psycopg2", "pymongo", "redis", "celery", "boto3", "botocore", "pytest", "tox", "black", "flake8", "pylint", "mypy", "isort", "pydantic", "beautifulsoup4", "lxml", "selenium", "scrapy",
  "pillow", "opencv-python", "click", "jinja2", "pyyaml", "toml", "setuptools", "wheel", "pip", "urllib3", "certifi", "cryptography", "paramiko", "pyjwt", "httpx", "aiohttp", "websockets",
  "python-dateutil", "pytz", "six", "attrs", "tqdm", "rich", "colorama", "jupyter", "ipython", "notebook", "streamlit", "dash", "plotly", "pyserial", "python-dotenv", "openai", "transformers",
];

/** The most characters two names may differ by and still be called a look-alike. */
const MAX_DISTANCE = 2;

/** Levenshtein distance, stopping early once it passes `limit` (names are short, but the list is not). */
export function editDistance(a: string, b: string, limit = MAX_DISTANCE): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > limit) return limit + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Names compared as people type them: a scope is kept, case and the separator between words do not matter. */
const squash = (n: string) => n.toLowerCase().replace(/[_.]/g, "-");

/**
 * The popular package this name looks like, when it is not that package itself. Only for npm and PyPI (the ecosystems with a list). A name shorter than 5 characters is never
 * called a look-alike: with so few letters, almost every name is within two of another.
 */
export function lookAlikeOf(ecosystem: string, name: string): string | undefined {
  const list = ecosystem === "npm" ? NPM_TOP : ecosystem === "pypi" ? PYPI_TOP : undefined;
  if (!list) return undefined;
  const n = squash(name.replace(/^@[^/]+\//, ""));
  if (n.length < 5) return undefined;
  if (list.some((t) => squash(t) === n)) return undefined;
  let best: { name: string; d: number } | undefined;
  for (const t of list) {
    const d = editDistance(n, squash(t));
    if (d >= 1 && d <= MAX_DISTANCE && (!best || d < best.d)) best = { name: t, d };
  }
  // A longer name that merely contains a popular one ("react-native-camera") is a different package, not a slip; the edit distance already keeps those apart.
  return best?.name;
}
