import { BlobError, BlobPreconditionFailedError } from '@vercel/blob';

// Blob can reject simultaneous conditional requests before comparing ETags.
// SDK 2.8.0 maps that observed service response to BlobError, not the dedicated
// precondition class. Match only this exact conflict, never arbitrary errors.
export function isConditionalConflict(error) {
  return error instanceof BlobPreconditionFailedError || (
    error instanceof BlobError && error.message === 'Vercel Blob: The conditional request cannot succeed due to a conflicting operation against this resource.'
  );
}
