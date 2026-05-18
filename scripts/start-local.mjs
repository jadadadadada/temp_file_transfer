process.env.HOST = process.env.HOST || "0.0.0.0";
process.env.ALLOW_EMPTY_PIN = process.env.ALLOW_EMPTY_PIN || "true";

await import("../server.js");
