import { spawnSync } from "node:child_process";

const composeArgs = process.argv.slice(2);

if (composeArgs.length === 0) {
  console.error("Usage: tsx scripts/compose.ts <compose args>");
  process.exit(1);
}

const runtime = pickContainerRuntime();
const args = ["compose", ...composeArgs];

console.log(`Using ${runtime} ${args.join(" ")}`);

const result = spawnSync(runtime, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    COMPOSE_BAKE: process.env.COMPOSE_BAKE ?? "false",
  },
});

if (result.error) {
  console.error(`Failed to start ${runtime}:`, result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);

function pickContainerRuntime(): "podman" | "docker" {
  if (commandExists("podman")) {
    return "podman";
  }

  if (commandExists("docker")) {
    return "docker";
  }

  console.error("Neither 'podman' nor 'docker' is available in PATH.");
  process.exit(1);
}

function commandExists(command: string): boolean {
  const result = spawnSync("sh", ["-lc", `command -v ${command}`], {
    stdio: "ignore",
  });
  return result.status === 0;
}