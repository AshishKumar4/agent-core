import {
    RunAdmissionValidationPort,
    type RunAdmissionReservation,
    type RunRepository
} from "../agents";

export class DurableRunAdmissionPort<Transaction> extends RunAdmissionValidationPort<Transaction> {
    public constructor(private readonly repository: RunRepository<Transaction>) {
        super();
    }

    public accepts(transaction: Transaction, reservation: RunAdmissionReservation): boolean {
        return (
            this.repository.loadAdmission(transaction, reservation.run)?.accepts(reservation) ===
            true
        );
    }
}
