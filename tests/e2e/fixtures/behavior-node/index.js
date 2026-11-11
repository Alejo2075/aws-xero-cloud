// Test fixture with controllable behaviour. Used only by the Docker end-to-end suite.
exports.handler = async (event, context) => {
  if (event.log) console.log(event.log);
  if (event.sleepMs) await new Promise((r) => setTimeout(r, event.sleepMs));
  if (event.allocateMb) { global.__hog = Buffer.alloc(event.allocateMb * 1024 * 1024, 1); }
  if (event.throw) throw new Error('intentional failure');
  if (event.env) return { env: process.env[event.env] ?? null };
  if (event.writeRoot) { require('fs').writeFileSync('/var/task/x', '1'); }
  if (event.crash) process.exit(1);
  return { ok: true, pid: process.pid, uid: process.getuid(), remaining: context.getRemainingTimeInMillis(), counter: (global.__n = (global.__n || 0) + 1) };
};
