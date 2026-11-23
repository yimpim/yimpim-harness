# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue.

Email **yimpim.dev@gmail.com** with "security" in the subject. Include what you found, how to reproduce it, and which version or commit you tested. If you can, say whether it needs a particular setup or only a crafted project.

We will read every report, reply, and tell you what we decide to do. Please give us reasonable time to fix a problem before you share it publicly.

## What is in scope

- The command-line harness in this repository: its file and command safety checks, secret handling, the OpenRouter key storage, and the way it talks to the hosted relay.
- The hosted YIMPIM Pro service (`broker.yimpim.com`) and the website (`yimpim.com`), reported to the same address.

## Things that are not vulnerabilities

- The agent doing something harmful you asked it to do, or a model producing wrong or insecure code. Review what it changes, use Git, and consider running it in a virtual machine or other sandbox. See the "Run it in a sandbox" note in the README.
- Findings from `/pentest` or the other security tools about your own projects. They are aids, not guarantees.

## Keys and secrets

Never put your OpenRouter key, a Pro lease or any other credential in an issue or a pull request. If you think a key was exposed, revoke it at [openrouter.ai/keys](https://openrouter.ai/keys) and create a new one.
