// garmin-personal-api: typed client for Garmin's official Garmin Connect Personal API.
// Library phase 1: the response types only. The client (createGarminClient) is phase 2.
//
// Types are generated from Garmin's OpenAPI spec after scripts/patch-spec.mjs corrects
// it to match real responses (nullable fields, epoch-ms sleep timestamps, string
// dates on heart rate, [timestamp, value] time series, single-object fitness age).

export type * from './types.gen';
