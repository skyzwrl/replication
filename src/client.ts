import { RunService, Workspace } from "@rbxts/services";
import { ENTITY_SIZE, HEADER_SIZE, isValidPacket, readNetId, readSequence, readTime, readTransform } from "./codec";
import { isNewerSequence } from "./sequence";
import { SnapshotBuffer } from "./snapshot-buffer";
import { ClientTransport, ReliableMessage } from "./transport";

// how quickly the arrival delay estimate follows changes in ping, per received packet
const ARRIVAL_SMOOTHING = 0.1;

export interface ReplicationClientOptions<K, H> {
	transport: ClientTransport<K>;
	spawn: (key: K, data: unknown, cframe: CFrame) => H;
	despawn?: (handle: H, key: K) => void;
	/** PivotTo on the handle by default */
	apply?: (handle: H, cframe: CFrame) => void;
	interpolationDelay?: number;
	maxExtrapolation?: number;
	snapDistance?: number;
	bufferSize?: number;
	clock?: () => number;
}

class ClientEntity<K, H> {
	public rendered?: CFrame;

	public constructor(
		public readonly id: number,
		public readonly key: K,
		public readonly handle: H,
		public readonly snapshots: SnapshotBuffer,
	) {}
}

function pivotTo(handle: unknown, cframe: CFrame): void {
	if (typeIs(handle, "Instance") && handle.IsA("PVInstance")) {
		handle.PivotTo(cframe);
	}
}

export class ReplicationClient<K extends defined, H extends defined = PVInstance> {
	private readonly transport: ClientTransport<K>;
	private readonly spawn: (key: K, data: unknown, cframe: CFrame) => H;
	private readonly despawn?: (handle: H, key: K) => void;
	private readonly apply: (handle: H, cframe: CFrame) => void;
	private readonly interpolationDelay: number;
	private readonly maxExtrapolation: number;
	private readonly snapDistance: number;
	private readonly bufferSize: number;
	private readonly clock: () => number;

	private readonly byId = new Map<number, ClientEntity<K, H>>();
	private readonly byKey = new Map<K, ClientEntity<K, H>>();
	private lastSequence?: number;
	private arrivalDelay?: number;
	private arrivalJitter = 0;
	private renderTime = -math.huge;
	private disconnectTransport?: () => void;
	private renderConnection?: RBXScriptConnection;

	public constructor(options: ReplicationClientOptions<K, H>) {
		this.transport = options.transport;
		this.spawn = options.spawn;
		this.despawn = options.despawn;
		this.apply = options.apply ?? pivotTo;
		// on top of the measured arrival delay. two ticks at the default 20 Hz, so one lost packet still
		// leaves something to interpolate towards
		this.interpolationDelay = options.interpolationDelay ?? 0.1;
		this.maxExtrapolation = options.maxExtrapolation ?? 0.1;
		this.snapDistance = options.snapDistance ?? 64;
		this.bufferSize = options.bufferSize ?? 32;
		this.clock = options.clock ?? (() => Workspace.GetServerTimeNow());
	}

	public start(): void {
		if (this.disconnectTransport !== undefined) {
			return;
		}
		this.disconnectTransport = this.transport.connect(
			(packet) => this.receiveSnapshot(packet),
			(message) => this.receiveReliable(message),
		);
		this.renderConnection = RunService.PreRender.Connect(() => this.render());
	}

	public stop(): void {
		this.disconnectTransport?.();
		this.disconnectTransport = undefined;
		this.renderConnection?.Disconnect();
		this.renderConnection = undefined;
	}

	public destroy(): void {
		this.stop();
		for (const [id] of this.byId) {
			this.remove(id);
		}
	}

	public receiveSnapshot(packet: buffer): boolean {
		if (!isValidPacket(packet)) {
			return false;
		}
		const sequence = readSequence(packet);
		if (this.lastSequence !== undefined && !isNewerSequence(sequence, this.lastSequence)) {
			return false;
		}
		this.lastSequence = sequence;

		const time = readTime(packet);
		this.trackArrival(this.clock() - time);
		const length = buffer.len(packet);
		for (let offset = HEADER_SIZE; offset < length; offset += ENTITY_SIZE) {
			const entity = this.byId.get(readNetId(packet, offset));
			// unknown ids belong to spawns still in flight on the reliable channel, the spawn carries a pose anyway
			if (entity !== undefined) {
				const newest = entity.snapshots.newestTime();
				if (newest === undefined || time > newest) {
					entity.snapshots.push(time, readTransform(packet, offset));
				}
			}
		}
		return true;
	}

	public receiveReliable(message: ReliableMessage<K>): void {
		for (const id of message.despawns) {
			this.remove(id);
		}
		for (const spawn of message.spawns) {
			this.remove(spawn.id);
			const snapshots = new SnapshotBuffer(this.bufferSize);
			snapshots.push(spawn.time, spawn.cframe);
			const entity = new ClientEntity(
				spawn.id,
				spawn.key,
				this.spawn(spawn.key, spawn.data, spawn.cframe),
				snapshots,
			);
			this.byId.set(spawn.id, entity);
			this.byKey.set(spawn.key, entity);
		}
	}

	public render(): void {
		// snapshots are stamped with server time and arrive a ping later, so rendering at a fixed offset
		// from server time would leave a laggy client permanently extrapolating
		const target = this.clock() - this.interpolationDelay - (this.arrivalDelay ?? 0) - this.arrivalJitter * 2;
		// never step backwards when the estimate grows, everything just holds for a moment instead
		this.renderTime = math.max(this.renderTime, target);

		const time = this.renderTime;
		for (const [, entity] of this.byId) {
			const cframe = entity.snapshots.sample(time, this.maxExtrapolation, this.snapDistance);
			if (cframe !== undefined) {
				entity.rendered = cframe;
				this.apply(entity.handle, cframe);
			}
		}
	}

	// the server time the client is currently showing, what lag compensation should rewind to
	public getRenderTime(): number {
		return this.renderTime;
	}

	public getRendered(key: K): CFrame | undefined {
		return this.byKey.get(key)?.rendered;
	}

	public getHandle(key: K): H | undefined {
		return this.byKey.get(key)?.handle;
	}

	public entityCount(): number {
		return this.byId.size();
	}

	private trackArrival(delay: number): void {
		const sample = math.max(delay, 0);
		if (this.arrivalDelay === undefined) {
			this.arrivalDelay = sample;
			return;
		}
		const deviation = sample - this.arrivalDelay;
		this.arrivalDelay += deviation * ARRIVAL_SMOOTHING;
		this.arrivalJitter += (math.abs(deviation) - this.arrivalJitter) * ARRIVAL_SMOOTHING;
	}

	private remove(id: number): void {
		const entity = this.byId.get(id);
		if (entity === undefined) {
			return;
		}
		this.byId.delete(id);
		if (this.byKey.get(entity.key) === entity) {
			this.byKey.delete(entity.key);
		}
		this.despawn?.(entity.handle, entity.key);
	}
}
