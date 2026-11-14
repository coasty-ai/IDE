# Third-party software in Workbench.app

Workbench itself is under the MIT License (`LICENSE`, beside this file in the app). The app also carries:

| Software | License | Where its full license text is in the app |
|---|---|---|
| Node.js, and the libraries it bundles | MIT, and the licenses listed in its own file | `Contents/Resources/node/LICENSE` |
| npm, and the packages it bundles | The Artistic License 2.0, and the licenses of its packages | `Contents/Resources/node/lib/node_modules/npm/LICENSE` and each package's own file |
| JetBrains Mono, the typeface of the page | SIL Open Font License 1.1 | `Contents/Resources/workbench/ui/fonts/OFL.txt` |

Node.js and npm are the official releases from nodejs.org, checked against their published SHA-256 checksums when the app is built.
