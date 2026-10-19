import { RunService, Workspace } from "@rbxts/services";
import { ENTITY_SIZE, HEADER_SIZE, MAX_NET_ID, QuantizedTransform, quantize, writeEntity, writeHeader } from "./codec";
import { Grid } from "./grid";
import { nextSequence } from "./sequence";
import { ServerTransport, SpawnMessage } from "./transport";

export interface ReplicationServerOptions<K, P> {
	transport: ServerTransport<K, P>;
	/** where a peer's interest is centred, the character root by default for Player peers */
	getFocus?: (peer: P) => Vector3 | undefined;
	tickRate?: number;
	interestRadius?: number;
	keyframeInterval?: number;
	/** extra ticks an entity is still sent after it stops changing, so a lost packet can't hide its final pose */
	redundancy?: number;
	positionThreshold?: number;
	rotationThreshold?: number;
	maxPacketSize?: number;
	clock?: () => number;
}

// leaving uses a slightly bigger radius than entering so things on the edge don't spawn and despawn every tick
const LEAVE_RADIUS_SCALE = 1.1;
// golden ratio steps spread the first keyframe of peers that join together across the interval. the
// first one never lands on the join tick, the spawn messages already carry the full state
const KEYFRAME_STAGGER = 0.618034;
// a rotation of θ moves the stored components by about θ / 2 * 32767 / sqrt(0.5) units
const ROTATION_UNITS_PER_RADIAN = 23170;

class Entity<K> {
	public readonly current = new QuantizedTransform();
	public readonly reference = new QuantizedTransform();
	public cframe: CFrame;
	public position: Vector3;
	public quietTicks: number;

	public constructor(
		public readonly id: number,
		public readonly key: K,
		public readonly read: () => CFrame,
		public readonly data: unknown,
		redundancy: number,
	) {
		this.cframe = read();
		this.position = this.cframe.Position;
		quantize(this.cframe, this.current);
		this.reference.copyFrom(this.current);
		// spawn messages already carry the starting pose, nothing to resend until it moves
		this.quietTicks = redundancy + 1;
	}
}

class Peer<K, P> {
	public readonly known = new Set<Entity<K>>();
	public spawns = new Array<SpawnMessage<K>>();
	public despawns = new Array<number>();
	public sequence = 0;

	public constructor(
		public readonly peer: P,
		public nextKeyframe: number,
	) {}
}

function defaultFocus(peer: unknown): Vector3 | undefined {
	if (typeIs(peer, "Instance") && peer.IsA("Player")) {
		return peer.Character?.PrimaryPart?.Position;
	}
	return undefined;
}

export class ReplicationServer<K extends defined, P extends defined = Player> {
	private readonly transport: ServerTransport<K, P>;
	private readonly getFocus: (peer: P) => Vector3 | undefined;
	private readonly interval: number;
	private readonly interestRadius: number;
	private readonly keyframeInterval: number;
	private readonly redundancy: number;
	private readonly positionThreshold: number;
	private readonly rotationUnits: number;
	private readonly maxPacketSize: number;
	private readonly clock: () => number;

	private readonly entities = new Map<K, Entity<K>>();
	private readonly peers = new Map<P, Peer<K, P>>();
	private readonly grid: Grid<Entity<K>>;
	private readonly candidates = new Array<Entity<K>>();
	private readonly freeIds = new Array<number>();
	private readonly scratch: buffer;
	private nextId = 0;
	private peersAdded = 0;
	private elapsed = 0;
	private connection?: RBXScriptConnection;

	public constructor(options: ReplicationServerOptions<K, P>) {
		this.transport = options.transport;
		this.getFocus = options.getFocus ?? defaultFocus;
		this.interval = 1 / (options.tickRate ?? 20);
		this.interestRadius = options.interestRadius ?? 512;
		this.keyframeInterval = options.keyframeInterval ?? 1;
		this.redundancy = options.redundancy ?? 3;
		this.positionThreshold = options.positionThreshold ?? 0.01;
		this.rotationUnits = math.max(math.round((options.rotationThreshold ?? 0.001) * ROTATION_UNITS_PER_RADIAN), 1);
		// unreliable remotes drop anything over 1000 bytes, packets are split below that
		this.maxPacketSize = math.clamp(options.maxPacketSize ?? 900, HEADER_SIZE + ENTITY_SIZE, 1000);
		this.clock = options.clock ?? (() => Workspace.GetServerTimeNow());
		this.grid = new Grid(this.interestRadius);
		this.scratch = buffer.create(this.maxPacketSize);
	}

	public register(key: K, read: () => CFrame, data?: unknown): number {
		if (this.entities.has(key)) {
			throw `${tostring(key)} is already replicated`;
		}
		const id = this.allocateId();
		const entity = new Entity(id, key, read, data, this.redundancy);
		this.entities.set(key, entity);
		this.grid.insert(entity, entity.position);
		return id;
	}

	public unregister(key: K): void {
		const entity = this.entities.get(key);
		if (entity === undefined) {
			return;
		}
		this.entities.delete(key);
		this.grid.remove(entity);
		for (const [, peer] of this.peers) {
			if (peer.known.delete(entity)) {
				peer.despawns.push(entity.id);
			}
		}
		this.freeIds.push(entity.id);
	}

	public isRegistered(key: K): boolean {
		return this.entities.has(key);
	}

	public addPeer(peer: P): void {
		if (this.peers.has(peer)) {
			return;
		}
		this.peersAdded += 1;
		const stagger = ((this.peersAdded * KEYFRAME_STAGGER) % 1) * this.keyframeInterval;
		this.peers.set(peer, new Peer(peer, this.clock() + stagger));
	}

	public removePeer(peer: P): void {
		this.peers.delete(peer);
	}

	public tick(): void {
		const now = this.clock();

		for (const [, entity] of this.entities) {
			const cframe = entity.read();
			entity.cframe = cframe;
			entity.position = cframe.Position;
			quantize(cframe, entity.current);
			if (this.hasMoved(entity)) {
				entity.reference.copyFrom(entity.current);
				entity.quietTicks = 0;
			} else if (entity.quietTicks <= this.redundancy) {
				entity.quietTicks += 1;
			}
			this.grid.move(entity, entity.position);
		}

		for (const [, peer] of this.peers) {
			this.updateInterest(peer, now);
			this.sendSnapshots(peer, now);
			if (!peer.spawns.isEmpty() || !peer.despawns.isEmpty()) {
				this.transport.sendReliable(peer.peer, { spawns: peer.spawns, despawns: peer.despawns });
				peer.spawns = [];
				peer.despawns = [];
			}
		}
	}

	public start(): void {
		if (this.connection !== undefined) {
			return;
		}
		this.connection = RunService.Heartbeat.Connect((deltaTime) => {
			this.elapsed += deltaTime;
			if (this.elapsed < this.interval) {
				return;
			}
			// keep the phase but never queue up more than one extra tick after a hitch
			this.elapsed = math.min(this.elapsed - this.interval, this.interval);
			this.tick();
		});
	}

	public stop(): void {
		this.connection?.Disconnect();
		this.connection = undefined;
		this.elapsed = 0;
	}

	private allocateId(): number {
		const reused = this.freeIds.pop();
		if (reused !== undefined) {
			return reused;
		}
		if (this.nextId > MAX_NET_ID) {
			throw `can't replicate more than ${MAX_NET_ID + 1} entities at once`;
		}
		const id = this.nextId;
		this.nextId += 1;
		return id;
	}

	private hasMoved(entity: Entity<K>): boolean {
		const current = entity.current;
		const reference = entity.reference;
		const dx = current.x - reference.x;
		const dy = current.y - reference.y;
		const dz = current.z - reference.z;
		if (dx * dx + dy * dy + dz * dz > this.positionThreshold * this.positionThreshold) {
			return true;
		}
		const units = this.rotationUnits;
		return (
			current.dropped !== reference.dropped ||
			math.abs(current.a - reference.a) > units ||
			math.abs(current.b - reference.b) > units ||
			math.abs(current.c - reference.c) > units
		);
	}

	private updateInterest(peer: Peer<K, P>, now: number): void {
		// no focus (character respawning) keeps the current set instead of despawning everything
		const focus = this.getFocus(peer.peer);
		if (focus === undefined) {
			return;
		}

		const leaveRadius = this.interestRadius * LEAVE_RADIUS_SCALE;
		for (const entity of peer.known) {
			if (entity.position.sub(focus).Magnitude > leaveRadius) {
				peer.known.delete(entity);
				peer.despawns.push(entity.id);
			}
		}

		for (const entity of this.grid.query(focus, this.interestRadius, this.candidates)) {
			if (!peer.known.has(entity) && entity.position.sub(focus).Magnitude <= this.interestRadius) {
				peer.known.add(entity);
				peer.spawns.push({
					id: entity.id,
					key: entity.key,
					data: entity.data,
					time: now,
					cframe: entity.cframe,
				});
			}
		}
	}

	private sendSnapshots(peer: Peer<K, P>, now: number): void {
		const keyframe = now >= peer.nextKeyframe;
		if (keyframe) {
			peer.nextKeyframe += this.keyframeInterval;
			if (peer.nextKeyframe <= now) {
				peer.nextKeyframe = now + this.keyframeInterval;
			}
		}

		let offset = HEADER_SIZE;
		for (const entity of peer.known) {
			if (!keyframe && entity.quietTicks > this.redundancy) {
				continue;
			}
			if (offset + ENTITY_SIZE > this.maxPacketSize) {
				this.flushPacket(peer, now, offset);
				offset = HEADER_SIZE;
			}
			writeEntity(this.scratch, offset, entity.id, entity.current);
			offset += ENTITY_SIZE;
		}
		if (offset > HEADER_SIZE) {
			this.flushPacket(peer, now, offset);
		}
	}

	private flushPacket(peer: Peer<K, P>, now: number, length: number): void {
		writeHeader(this.scratch, peer.sequence, now);
		peer.sequence = nextSequence(peer.sequence);
		const packet = buffer.create(length);
		buffer.copy(packet, 0, this.scratch, 0, length);
		this.transport.sendSnapshot(peer.peer, packet);
	}
}
