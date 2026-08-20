import { createHash, randomBytes } from "node:crypto";
function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}
function randomToken(bytes = 48) {
  return randomBytes(bytes).toString("base64url");
}
export {
  randomToken,
  sha256Hex
};
