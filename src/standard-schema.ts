/**
 * The part of the Standard Schema v1 interface (https://standardschema.dev) that ImportKit calls. Zod, Valibot, ArkType
 * and other validation libraries implement it, so their schemas can be passed as they are.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1Props<Input, Output>;
}

export interface StandardSchemaV1Props<Input = unknown, Output = Input> {
  readonly version: 1;
  readonly vendor: string;
  readonly validate: (value: unknown) => StandardSchemaV1Result<Output> | Promise<StandardSchemaV1Result<Output>>;
  readonly types?: { readonly input: Input; readonly output: Output } | undefined;
}

export type StandardSchemaV1Result<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardSchemaV1Issue[] };

export interface StandardSchemaV1Issue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined;
}
