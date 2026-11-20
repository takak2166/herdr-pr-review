# Contributing

Issues and pull requests are welcome. This is maintained in spare time, so replies may take a while.

## Developing

1. Install the layout as the README says, so `~/.config/herdr-app/mods/pr-review/` is the copy Herdr runs.
2. Edit the files there. Herdr reloads the mod on every save.
3. Run `herdr-app check ~/.config/herdr-app/mods/pr-review` after each change; it must pass.
4. Try the change in the app (`layout.switch {name: "pr-review"}`), in English and in Japanese (the language switch at the list's foot).
5. Copy the changed files into this repository and open a pull request. Say what you changed and how you tried it.

`RECIPE.md` describes how the screen is built and what tends to go wrong; please keep it true when behavior changes.

## Words on the screen

Every word the screen shows is written in both languages: `L("日本語", "English")` from `mods/pr-review/i18n.js`. If you don't write Japanese, put your English in both places and say so in the pull request.

## Releasing

1. Add a section for the new version at the top of `CHANGELOG.md` ([Semantic Versioning](https://semver.org/)).
2. Commit, then tag it: `git tag -a vX.Y.Z -m vX.Y.Z` and push the tag.
3. Create the GitHub release from that section: `gh release create vX.Y.Z --title vX.Y.Z --notes-file <the section>`.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
