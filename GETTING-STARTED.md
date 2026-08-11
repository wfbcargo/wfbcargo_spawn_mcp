# Getting started

A friendly walkthrough for building a [Spawn](https://www.spawn.co) game with an AI assistant. No prior experience with MCP servers needed. If you're comfortable with the technical details, the [README](README.md) is the short version.

## What this actually does

Spawn lets you build multiplayer 3D games. This tool connects your **AI coding assistant** (Cursor, Claude Code, or similar) directly to your Spawn game.

Once it's set up, you don't type commands yourself. You just talk to your assistant:

> *"Add a floating island in the north with a bridge to it."*

and it will write the game code, push it live, **open the game in a browser, look at a screenshot of what it made**, and fix it if it looks wrong, then tell you when it's done.

That last part is the interesting bit. Without this, an AI can write game code but has no way to see the result, so it tends to confidently tell you something works when it doesn't. Here it can actually look.

**The mental model:** you talk to your assistant, your assistant uses these tools. You will rarely type a tool name yourself.

## Before you start

You'll need four things:

1. **A Spawn account.** Sign up at [spawn.co](https://www.spawn.co).
2. **An AI coding assistant that supports MCP.** Cursor, Claude Code, Claude Desktop, or another MCP-compatible tool.
3. **Node.js version 18 or newer.** Get it from [nodejs.org](https://nodejs.org). To check if you already have it, open a terminal and run `node --version`.
4. **A terminal.** On Windows that's PowerShell or Command Prompt; on Mac it's Terminal. You'll only need it for the one-time setup below.

## Step 1: Install (one time, ~2 minutes)

Open a terminal and run these four lines one at a time:

```bash
git clone https://github.com/wfbcargo/wfbcargo_spawn_mcp.git
cd wfbcargo_spawn_mcp
npm install
npm run build
```

Then, if you want your assistant to be able to *see* your game (recommended, since it's most of the value):

```bash
npm run setup
```

That downloads a copy of Chrome for the assistant to play your game in. It's about 150MB and takes a minute. You can skip it and add it later; everything else works without it.

Finally, note where this folder lives. Run `pwd` (Mac/Linux) or `cd` (Windows) and copy the path. You'll need it in the next step. It'll look something like `/Users/you/wfbcargo_spawn_mcp` or `C:/Users/you/wfbcargo_spawn_mcp`.

## Step 2: Make a folder for your game

This trips people up, so it's worth being explicit: **your game is a separate folder from this tool.**

- `wfbcargo_spawn_mcp` is the tool you just installed. You won't edit anything in here.
- `my-first-game` is your actual game. Make this now, anywhere you like.

```bash
mkdir my-first-game
```

Note this path too.

> **If you plan to run several assistants at once**, give each one its own game folder. They'll fight over the same files otherwise. They can all still work on the *same game*. See [Working with a team of assistants](#working-with-a-team-of-assistants) below.

## Step 3: Connect it to your assistant

You need to tell your assistant that this tool exists. How you do that depends on which one you use.

Wherever you put it, the configuration is the same shape. **Replace both paths with your own** from steps 1 and 2, and use forward slashes `/` even on Windows:

```json
{
  "mcpServers": {
    "spawn": {
      "command": "node",
      "args": ["C:/Users/you/wfbcargo_spawn_mcp/dist/index.js"],
      "env": {
        "SPAWN_PROJECT_DIR": "C:/Users/you/my-first-game"
      }
    }
  }
}
```

**Cursor:** create or edit `.cursor/mcp.json` inside your game folder, or `~/.cursor/mcp.json` to enable it everywhere. Paste the above.

**Claude Code:** from inside your game folder, run:

```bash
claude mcp add spawn --env SPAWN_PROJECT_DIR=C:/Users/you/my-first-game -- node C:/Users/you/wfbcargo_spawn_mcp/dist/index.js
```

**Claude Desktop:** edit `claude_desktop_config.json` and paste the above. Find it at `%APPDATA%\Claude\` on Windows, or `~/Library/Application Support/Claude/` on Mac.

**Restart your assistant** after making the change. It won't notice otherwise.

To check it worked, ask your assistant: *"What spawn tools do you have?"* It should list around 25, all starting with `spawn_`.

## Step 4: Connect to your Spawn account

Your assistant needs permission to touch your game. This is a one-time handshake.

1. In Spawn, open the **gear icon** → **Build with a coding agent**.
2. You'll get a setup key starting with `sbk_`. **It expires in about 5 minutes and only works once**, so do the next step right away.
3. Paste it to your assistant with something like:

   > *"Connect to Spawn with this key: sbk_xxxxxxxx"*

Your assistant will trade that short-lived key for a long-lived one and save it in a `.env` file inside your game folder. From then on it stays connected, so you won't need to do this again.

**Don't share that `.env` file, commit it to GitHub, or paste its contents anywhere.** It's the key to your Spawn account. The tool never prints the full key back to you, and automatically tells git to ignore the file.

## Step 5: Make a game

Now just ask:

> *"Create a new Spawn game and set up the project."*

Your assistant will create the game, scaffold the folders, and download Spawn's engine documentation so it knows how the world works. It'll give you a link to open your game in the browser. Keep that tab open; it updates live.

Then start building:

> *"Make a small island with some trees and a stone tower in the middle."*

Expect it to take a minute or two: it writes the code, pushes it, opens its own browser window, screenshots the result, and adjusts if it doesn't look right. The browser window that pops up is your assistant looking at your game. You can watch, or ignore it.

## Things worth asking for

| What you want | What to say |
|---|---|
| See what it made | *"Take a screenshot of the game."* |
| Test that something works | *"Walk around and check I can actually climb the tower."* |
| Fix something broken | *"The bridge is floating. Check the logs and fix it."* |
| Understand the world | *"What objects are in the world right now?"* |
| Roll back a bad session | *"Reset my project back to the last published version."* |
| Work quietly | *"Run the game browser hidden from now on."* |

## Publishing

**Your assistant cannot publish your game. Only you can, from the Spawn website.** This is deliberate.

Think of it as two versions: the **live** version players see, and the **draft** your assistant is changing. Publishing in the Spawn UI copies the current draft to live. So players keep a stable game even while your assistant is mid-experiment.

If you're going to have assistants working on a game for a while, publish once first so there's a good version for players to land on.

## Working with a team of assistants

You can run several assistants on the same game at once: one on terrain, one on gameplay, one on lighting. It genuinely works, but two rules matter:

1. **Each assistant needs its own game folder.** Sharing one folder makes them overwrite each other's files.
2. **Each assistant needs its own setup key.** Go back to Spawn's gear → *Build with a coding agent* for each one, and give each a name like *"terrain-agent"* when connecting.

Point them all at the same game, and start with two or three before scaling up. If two assistants change the same thing at once, one will get a "version conflict". That's normal and expected. Just tell it: *"Pull the latest version, merge it, and push again."*

## When something goes wrong

| What you see | What to do |
|---|---|
| Assistant says it has no spawn tools | Restart it. If that fails, check the paths in your config are correct and use `/` not `\`. |
| "Bootstrap failed" / "expired" | The `sbk_` key expired; they last about 5 minutes. Get a fresh one and retry immediately. |
| "Executable doesn't exist" / no browser | You skipped `npm run setup`. Run it in the tool folder. |
| Assistant can't see the game | Ask it to *"reload the game browser."* |
| "version_conflict" | Someone else changed the game. Say *"pull the latest, merge, and push again."* |
| Game looks unchanged after a push | Ask for a screenshot. You may be looking at your own stale browser tab. Refresh it. |
| Nothing works and you're stuck | Ask: *"Run spawn_status and tell me what's wrong."* It reports the connection, versions, and any unresolved conflicts in plain terms. |

## A note on trust

This tool gives an AI assistant real abilities: it writes files on your computer, runs code in your game, and controls a browser. That's the point, but it's worth knowing.

Two practical habits:

- **Keep your game folder separate** from anything sensitive.
- **Be careful with game projects other people wrote**, the same way you'd be careful running a downloaded program.

The technical detail is in the README's [Trust model](README.md#trust-model) section if you want it.

## Where to go next

- [README](README.md) has the full tool list and the technical reference.
- Once your assistant has run the setup step, it downloads Spawn's own guides into a `.spawn/` folder in your game. Ask it: *"What can the Spawn engine actually do?"* and it'll tell you from those.
