import { ENTITY_SIZE, HEADER_SIZE, QuantizedTransform, quantize, readNetId, writeEntity, writeHeader } from "../codec";
import { ReliableMessage, ServerTransport } from "../transport";

export class Lcg {
	public constructor(private state: number) {}

	public next(): number {
		this.state = (this.state * 1664525 + 1013904223) % 4294967296;
		return this.state / 4294967296;
	}

	public range(min: number, max: number): number {
		return min + (max - min) * this.next();
	}
}

export function angleBetween(a: CFrame, b: CFrame): number {
	const [, angle] = a.Rotation.Inverse().mul(b.Rotation).ToAxisAngle();
	return math.abs(angle);
}

export function packet(sequence: number, time: number, entities: Array<[id: number, cframe: CFrame]>): buffer {
	const result = buffer.create(HEADER_SIZE + entities.size() * ENTITY_SIZE);
	const transform = new QuantizedTransform();
	writeHeader(result, sequence, time);
	entities.forEach(([id, cframe], index) => {
		writeEntity(result, HEADER_SIZE + index * ENTITY_SIZE, id, quantize(cframe, transform));
	});
	return result;
}

export function idsIn(source: buffer): number[] {
	const ids = new Array<number>();
	for (let offset = HEADER_SIZE; offset < buffer.len(source); offset += ENTITY_SIZE) {
		ids.push(readNetId(source, offset));
	}
	return ids;
}

export class RecordingTransport<K extends defined, P> implements ServerTransport<K, P> {
	public snapshots = new Array<{ peer: P; packet: buffer }>();
	public reliable = new Array<{ peer: P; message: ReliableMessage<K> }>();

	public sendSnapshot(peer: P, source: buffer): void {
		this.snapshots.push({ peer, packet: source });
	}

	public sendReliable(peer: P, message: ReliableMessage<K>): void {
		this.reliable.push({ peer, message });
	}

	public snapshotsFor(peer: P): buffer[] {
		const result = new Array<buffer>();
		for (const entry of this.snapshots) {
			if (entry.peer === peer) {
				result.push(entry.packet);
			}
		}
		return result;
	}

	public sentIds(peer: P): number[] {
		const ids = new Array<number>();
		for (const source of this.snapshotsFor(peer)) {
			for (const id of idsIn(source)) {
				ids.push(id);
			}
		}
		ids.sort();
		return ids;
	}

	public spawnedKeys(peer: P): K[] {
		const keys = new Array<K>();
		for (const entry of this.reliable) {
			if (entry.peer === peer) {
				for (const spawn of entry.message.spawns) {
					keys.push(spawn.key);
				}
			}
		}
		return keys;
	}

	public despawnedIds(peer: P): number[] {
		const ids = new Array<number>();
		for (const entry of this.reliable) {
			if (entry.peer === peer) {
				for (const id of entry.message.despawns) {
					ids.push(id);
				}
			}
		}
		return ids;
	}

	public clear(): void {
		this.snapshots = [];
		this.reliable = [];
	}
}
