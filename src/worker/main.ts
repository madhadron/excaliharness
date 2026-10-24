// Orchestrator worker entry point, started by the extension with fork().
import { handleMessage } from "./protocol";

if (!process.send) {
  console.error("excaliharness worker must be started with an IPC channel");
  process.exit(1);
}

process.on("message", (message: unknown) => {
  const response = handleMessage(message);
  // A send error means the extension is gone; exit as on disconnect.
  if (!response) return;
  process.send?.(response, (error: Error | null) => {
    if (error) process.exit(0);
  });
});

// The extension went away (window closed or extension host crashed).
process.on("disconnect", () => process.exit(0));
