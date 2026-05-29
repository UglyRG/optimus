const { spawn } = require("node:child_process");

const services = [
  {
    name: "backend",
    command: ".venv/bin/uvicorn",
    args: ["optimus_api.main:app", "--reload", "--host", "localhost", "--port", "8788"],
    cwd: "backend_py",
  },
  { name: "frontend-react", command: "npm", args: ["run", "frontend:react"] },
];

const children = new Map();
let shuttingDown = false;

function prefixLines(name, stream) {
  let buffered = "";

  stream.on("data", (chunk) => {
    buffered += chunk.toString();
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() || "";

    for (const line of lines) {
      if (line) {
        console.log(`[${name}] ${line}`);
      }
    }
  });

  stream.on("end", () => {
    if (buffered) {
      console.log(`[${name}] ${buffered}`);
    }
  });
}

function stopAll(signal = "SIGTERM") {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log("\nStopping Optimus services...");

  for (const child of children.values()) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}

for (const service of services) {
  const child = spawn(service.command, service.args, {
    cwd: service.cwd || process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  children.set(service.name, child);
  prefixLines(service.name, child.stdout);
  prefixLines(service.name, child.stderr);

  child.on("exit", (code, signal) => {
    children.delete(service.name);

    if (!shuttingDown && code !== 0) {
      console.error(`[${service.name}] exited with ${signal || `code ${code}`}`);
      stopAll();
      process.exitCode = code || 1;
      return;
    }

    if (children.size === 0) {
      process.exit(process.exitCode || 0);
    }
  });
}

console.log("Starting Optimus services...");
console.log("Backend:         http://localhost:8788");
console.log("React frontend:  http://localhost:5173");
console.log("Press Ctrl+C to stop all services.");

process.on("SIGINT", () => stopAll("SIGINT"));
process.on("SIGTERM", () => stopAll("SIGTERM"));
