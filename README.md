# Verdigit

[![Support me on Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20me-3ddc84?logo=kofi&logoColor=white)](https://ko-fi.com/iammrveee)

A dark & green desktop Git client in the spirit of GitKraken and Sourcetree, with Git Flow built in.
Built with Electron, React and TypeScript on top of the `git` command line, so it behaves exactly like
git does on your machine: same config, credential helpers, SSH keys and hooks.

## Install

Download from the [Releases page](https://github.com/VivianHodgkinson/Verdigit/releases). Linux builds are available for x64 and ARM64; the Windows build is x64 and also runs on Windows on ARM through its built-in emulation.

| Platform | File | Install |
| --- | --- | --- |
| Windows 10/11 | `Verdigit-<ver>-setup-x64.exe` | Run the installer. A `-portable-x64.exe` that needs no install is also provided. |
| Ubuntu, Debian, Mint, Pop!_OS, elementary | `.deb` | `sudo apt install ./Verdigit-<ver>-linux-amd64.deb` |
| Fedora, RHEL, Rocky, Alma, openSUSE | `.rpm` | `sudo dnf install ./Verdigit-<ver>-linux-x86_64.rpm` (openSUSE: `sudo zypper install ./…rpm`) |
| Arch, Manjaro, EndeavourOS | `.pacman` | `sudo pacman -U ./Verdigit-<ver>-linux-x64.pacman` |
| Any other distro | `.AppImage` | `chmod +x Verdigit-*.AppImage && ./Verdigit-*.AppImage` |
| Any other distro | `.tar.gz` | Extract and run `sourcecontrol` |

**Which file?** Most PCs and laptops need the **x64** build, named `x86_64`, `amd64` or `x64` depending on the package. Only pick `arm64` or `aarch64` on an ARM machine (e.g. a Raspberry Pi or an ARM laptop running Linux). Not sure? Run `uname -m`.

Verdigit needs Git. The Linux packages install it as a dependency. On Windows, install [Git for Windows](https://git-scm.com/download/win); the app tells you if Git is missing.

## Updates

Verdigit checks GitHub for new **published** releases on startup and every few hours (turn this off in Settings → Updates, or use *Check now*).

- **Windows installer and AppImage** download the update in the background. A *Restart to update* button appears in the top bar, and the update also installs whenever you quit.
- **Portable exe, .deb, .rpm, .pacman and .tar.gz** show a *vX available* button that opens the release page, so your package manager stays in charge.

## Releasing

CI (`.github/workflows/build.yml`) runs the tests on Ubuntu and Windows and builds every package on each push. To publish a release:

```sh
npm version 0.2.0          # bumps package.json and creates the v0.2.0 tag
git push --follow-tags
```

The tag build uploads all installers to a **draft** GitHub Release. Review it and click *Publish*. Installed copies only see an update once the release is published.

## Running from source

```sh
npm install
npm run dev        # development with hot reload
npm run build      # production build into out/
npm start          # run the production build
npm run dist:linux # AppImage, deb, rpm, pacman, tar.gz into dist/ (deb/rpm/pacman need rpm + bsdtar installed)
npm run dist:win   # Windows installer + portable exe (run on Windows, or on Linux with Wine)
npm test           # backend integration tests against real temporary repos
npm run typecheck
```

Requires `git` on your `PATH`. The `git-flow` extension is **not** needed.

## Features

**History**
- Commit graph with coloured lanes, author avatars, and branch/tag pills. It's virtualised, so large histories stay fast.
- Search commits by message, author, SHA or ref (`Ctrl+F`, `Enter` / `Shift+Enter` to step through matches).
- Commit details with changed files and line stats. Ctrl+click a second commit to compare any two.
- File history and blame views.

**Working tree**
- Stage or unstage whole files, **individual hunks, or individual lines** (click line numbers, Shift+click for ranges).
- Discard files, hunks or lines. Ignore files or extensions via `.gitignore` from the context menu.
- Unified and split diff views, with an ignore-whitespace toggle.
- Commit, amend, or commit & push. Summary length counter. `Ctrl+Enter` to commit.

**Branching & history rewriting**
- Create, checkout (including tracking remote branches), rename and delete branches (local and remote). Set upstream.
- Merge (fast-forward, `--no-ff`, ff-only, squash), rebase, cherry-pick, revert, reset (soft/mixed/hard).
- Undo last commit, edit the last commit message.
- **Interactive rebase**: reorder, pick, reword, squash, fixup, drop.
- Merge/rebase/cherry-pick in-progress banner with Continue / Skip / Abort.
- **Conflict editor**: choose ours / theirs / both per conflict, then save & mark resolved.

**Remotes**
- Fetch (with prune), pull (merge / rebase / ff-only), push (with set-upstream; offers force-with-lease when rejected).
- Add, edit, rename and remove remotes. Push and delete tags.
- Credential prompts (HTTPS passwords/tokens, SSH passphrases, host-key confirmation) appear as in-app dialogs.

**Git Flow** (native, compatible with git-flow AVH config)
- Initialise with custom branch names and prefixes.
- Start / finish / publish **feature, bugfix, release, hotfix**; start **support** branches.
- Release and hotfix finish tag the version and back-merge the tag into `develop` (hotfixes go into an open release branch if there is one).
- If a finish stops on a merge conflict, resolve it, commit, and click Finish again to carry on.

**GitHub** (optional, needs a personal access token with `repo` scope in Settings)
- Browse and clone your repositories.
- Create pull requests (draft supported), with base branch defaulting to `develop` for Git Flow branches.
- The token also authenticates HTTPS pushes to github.com. It's stored encrypted with your OS keychain.

**Other**
- Dark, light, or follow-the-system theme: switch in Settings → Appearance, or with the sun/moon button in the top bar.
- Multiple repositories in tabs, recent repositories, auto-refresh when the repo changes.
- Stashes (save with untracked / keep-index, apply, pop, drop, inspect files).
- Git console showing every command the app runs (bottom-right of the status bar).
- Open in terminal / file manager / external editor.

## Project layout

```
src/main/        Electron main process
  runner.ts      spawns git, logs commands to the console
  git.ts         all git operations + output parsing
  gitflow.ts     native Git Flow implementation
  github.ts      GitHub REST API (repos, pull requests)
  askpass.ts     relays git/ssh credential prompts to the UI
  store.ts       settings + encrypted token storage
src/preload/     IPC bridge (single typed `api` channel)
src/shared/      types and the Api interface shared by both sides
src/renderer/    React UI
  src/repo.tsx       per-repository state, refresh & busy handling
  src/actions.tsx    every user action and context menu
  src/lib/graph.ts   commit graph lane layout
  src/lib/diff.ts    diff parsing, hunk/line patch building, conflict parsing
  src/components/    views, panels and dialogs
test/            backend integration tests
```

Keyboard: `Ctrl+P` switch repository · `Ctrl+Tab` / `Ctrl+Shift+Tab` next / previous tab · `F5` refresh · `Ctrl+F` search · `↑/↓` move through commits · `Esc` close diff/blame/history · `F12` dev tools.

## Support

Verdigit is free and open source. If it saves you some time, you can [buy me a coffee on Ko-fi](https://ko-fi.com/iammrveee). It's appreciated, never expected.

## License

[MIT](LICENSE) © 2026 Vivian Hodgkinson
