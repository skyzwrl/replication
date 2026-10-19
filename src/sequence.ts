const RANGE = 65536;
const HALF_RANGE = 32768;

export function nextSequence(sequence: number): number {
	return (sequence + 1) % RANGE;
}

// serial number arithmetic: a counts as newer when it's ahead of b by less than half the range, so
// sequence 3 is newer than 65530 once the counter has wrapped
export function isNewerSequence(a: number, b: number): boolean {
	const ahead = (a - b + RANGE) % RANGE;
	return ahead !== 0 && ahead < HALF_RANGE;
}
