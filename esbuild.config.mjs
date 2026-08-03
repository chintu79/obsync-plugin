import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const production = process.argv[2] === "production";
const banner = {
  js: `/*
  Obsync — free P2P sync for Obsidian.
  Built from the Rust engine (MIT OR Apache-2.0).
*/
`,
};

const external = [
  ...builtins,
  ...builtins.map((m) => `node:${m}`),
  "obsidian",
];
const context = await esbuild.context({
  banner,
  entryPoints: ["main.ts"],
  bundle: true,
  external,
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
});

if (production) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}