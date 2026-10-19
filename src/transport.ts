export interface SpawnMessage<K> {
	id: number;
	key: K;
	data?: unknown;
	time: number;
	cframe: CFrame;
}

// despawns are handled before spawns, so an id freed and reused in the same tick arrives in a safe order
export interface ReliableMessage<K> {
	spawns: SpawnMessage<K>[];
	despawns: number[];
}

export interface ServerTransport<K, P> {
	sendSnapshot(peer: P, packet: buffer): void;
	sendReliable(peer: P, message: ReliableMessage<K>): void;
}

export interface ClientTransport<K> {
	connect(onSnapshot: (packet: buffer) => void, onReliable: (message: ReliableMessage<K>) => void): () => void;
}
