export abstract class Durability {
    public static get accepted(): Durability {
        return accepted;
    }

    public static get buffered(): Durability {
        return buffered;
    }

    public static get durable(): Durability {
        return durable;
    }

    protected constructor(public readonly name: string) {
    }

    public satisfies(required: Durability): boolean {
        return this.rank >= required.rank;
    }

    protected abstract get rank(): number;
}

class Accepted extends Durability {
    public constructor() {
        super("accepted");
    }

    protected get rank(): number {
        return 0;
    }
}

class Buffered extends Durability {
    public constructor() {
        super("buffered");
    }

    protected get rank(): number {
        return 1;
    }
}

class Durable extends Durability {
    public constructor() {
        super("durable");
    }

    protected get rank(): number {
        return 2;
    }
}

const accepted = new Accepted();
const buffered = new Buffered();
const durable = new Durable();
