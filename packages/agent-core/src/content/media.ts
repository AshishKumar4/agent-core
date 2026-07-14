const MAX_MEDIA_TYPE_LENGTH = 255;

export class MediaHint {
    public constructor(public readonly mediaType: string) {
        if (mediaType.trim().length === 0 || mediaType.length > MAX_MEDIA_TYPE_LENGTH) {
            throw new TypeError(
                `Media type must not be blank or exceed ${MAX_MEDIA_TYPE_LENGTH} characters`
            );
        }
        Object.freeze(this);
    }
}
