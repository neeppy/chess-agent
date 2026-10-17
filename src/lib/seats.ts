// Browser-side memory: the seat keys this browser holds per room, recently visited rooms, and the
// name to take seats with. All in localStorage; every access tolerates storage being unavailable.

export interface StoredSeat {
	key: string;
	playerId: number;
}

const SEATS = 'chess:seats';
const ROOMS = 'chess:rooms';
const NAME = 'chess:name';

function read<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(key);
		return raw ? (JSON.parse(raw) as T) : fallback;
	} catch {
		return fallback;
	}
}

function write(key: string, value: unknown) {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		/* storage unavailable */
	}
}

export function seatsIn(room: string): StoredSeat[] {
	return read<Record<string, StoredSeat[]>>(SEATS, {})[room] ?? [];
}

export function rememberSeat(room: string, seat: StoredSeat) {
	const all = read<Record<string, StoredSeat[]>>(SEATS, {});
	all[room] = [...(all[room] ?? []).filter((s) => s.playerId !== seat.playerId), seat];
	write(SEATS, all);
	rememberRoom(room);
}

/** Recently visited rooms, most recent first. */
export function knownRooms(): string[] {
	return read<string[]>(ROOMS, []);
}

export function rememberRoom(room: string) {
	write(ROOMS, [room, ...knownRooms().filter((r) => r !== room)].slice(0, 20));
}

export function forgetRoom(room: string) {
	write(ROOMS, knownRooms().filter((r) => r !== room));
}

export const savedName = () => read<string>(NAME, '');
export const saveName = (name: string) => write(NAME, name);
