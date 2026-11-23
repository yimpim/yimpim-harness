# Contributing

Thanks for helping. Bug reports, ideas and pull requests are welcome.

## Before you start

- **Bugs and ideas:** open an issue with what you did, what you expected, and what happened. For a bug, say your operating system, Node version and the commit you are on.
- **Security problems:** do not open an issue. See [`SECURITY.md`](SECURITY.md).
- **Larger changes:** open an issue first so we can agree on the approach before you spend time on it.

## Working on the code

You need Node.js 22 or newer and Git.

```bash
git clone https://github.com/yimpim/yimpim-harness.git
cd yimpim-harness
npm install
npm test            # the whole suite
npm run check       # type check
```

`npm run dev` runs the CLI from source.

## Pull requests

- Keep each pull request to one change, and add or update tests for what you changed. The suite must pass.
- Settings live in one registry, `src/settings.ts`. Add a setting there and it appears in `config list`, `init`, validation and help.
- Do not commit secrets, `.env` files, personal paths, or notes meant only for you.
- Write commit messages that say what changed and why, in plain words.

## License

By contributing you agree that your work is licensed under the Apache License 2.0, the same as the rest of the project (see [`LICENSE`](LICENSE)).
