let held = false;

/** The composer holds updates while the user has a draft in flight. */
export function setUpdateHold(value: boolean): void {
  held = value;
}

export function isUpdateHeld(): boolean {
  return held;
}
