import { ClientTransport, ReliableMessage, ServerTransport } from "./transport";

export interface LoopbackOptions {
	clock: () => number;
	latency?: number;
	/** extra random delay on unreliable packets, enough of it reorders them */
	jitter?: number;
	/** chance an unreliable packet is dropped, 0 to 1 */
	loss?: number;
	seed?: number;
}

interface Handlers<K> {
	snapshot: (packet: buffer) => void;
	reliable: (message: ReliableMessage<K>) => void;
}

interface InFlight<K, P> {
	peer: P;
	arrival: number;
	order: number;
	snapshot?: buffer;
	reliable?: ReliableMessage<K>;
}

class LoopbackClient<K, P extends defined> implements ClientTransport<K> {
	public constructor(
		private readonly network: LoopbackNetwork<K, P>,
		private readonly peer: P,
	) {}

	public connect(
		onSnapshot: (packet: buffer) => void,
		onReliable: (message: ReliableMessage<K>) => void,
	): () => void {
		return this.network.listen(this.peer, { snapshot: onSnapshot, reliable: onReliable });
	}
}

// in-memory stand-in for the remotes with latency, jitter and loss, driven by whatever clock the test owns
export class LoopbackNetwork<K, P extends defined> implements ServerTransport<K, P> {
	public latency: number;
	public jitter: number;
	public loss: number;
	public sent = 0;
	public dropped = 0;

	private readonly clock: () => number;
	private readonly handlers = new Map<P, Handlers<K>>();
	private readonly lastReliableArrival = new Map<P, number>();
	private inFlight = new Array<InFlight<K, P>>();
	private order = 0;
	private seed: number;

	public constructor(options: LoopbackOptions) {
		this.clock = options.clock;
		this.latency = options.latency ?? 0;
		this.jitter = options.jitter ?? 0;
		this.loss = options.loss ?? 0;
		this.seed = options.seed ?? 1;
	}

	public client(peer: P): ClientTransport<K> {
		return new LoopbackClient(this, peer);
	}

	public listen(peer: P, handlers: Handlers<K>): () => void {
		this.handlers.set(peer, handlers);
		return () => {
			if (this.handlers.get(peer) === handlers) {
				this.handlers.delete(peer);
			}
		};
	}

	public sendSnapshot(peer: P, packet: buffer): void {
		this.sent += 1;
		if (this.random() < this.loss) {
			this.dropped += 1;
			return;
		}
		// remotes serialize their arguments, so the receiver never shares the sender's buffer
		const copy = buffer.create(buffer.len(packet));
		buffer.copy(copy, 0, packet);
		const arrival = this.clock() + this.latency + this.random() * this.jitter;
		this.enqueue({ peer, arrival, order: this.order, snapshot: copy });
	}

	public sendReliable(peer: P, message: ReliableMessage<K>): void {
		// reliable remotes keep their order, a message never overtakes the previous one
		const arrival = math.max(this.clock() + this.latency, this.lastReliableArrival.get(peer) ?? 0);
		this.lastReliableArrival.set(peer, arrival);
		this.enqueue({ peer, arrival, order: this.order, reliable: message });
	}

	public deliver(): void {
		const now = this.clock();
		const due = new Array<InFlight<K, P>>();
		const pending = new Array<InFlight<K, P>>();
		for (const message of this.inFlight) {
			if (message.arrival <= now) {
				due.push(message);
			} else {
				pending.push(message);
			}
		}
		this.inFlight = pending;

		due.sort((a, b) => a.arrival < b.arrival || (a.arrival === b.arrival && a.order < b.order));
		for (const message of due) {
			const handlers = this.handlers.get(message.peer);
			if (handlers === undefined) {
				continue;
			}
			if (message.snapshot !== undefined) {
				handlers.snapshot(message.snapshot);
			} else if (message.reliable !== undefined) {
				handlers.reliable(message.reliable);
			}
		}
	}

	public pending(): number {
		return this.inFlight.size();
	}

	private enqueue(message: InFlight<K, P>): void {
		this.order += 1;
		this.inFlight.push(message);
	}

	private random(): number {
		this.seed = (this.seed * 1664525 + 1013904223) % 4294967296;
		return this.seed / 4294967296;
	}
}
