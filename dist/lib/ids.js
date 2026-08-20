import { randomUUID } from "node:crypto";
function newId() {
  return randomUUID();
}
export {
  newId
};
