export interface SchemaNode<T = unknown> {
  default(value: T): SchemaNode<T>;
  description(value: string): SchemaNode<T>;
  role(value: string): SchemaNode<T>;
  required(): SchemaNode<T>;
  step(value: number): SchemaNode<T>;
  min(value: number): SchemaNode<T>;
  max(value: number): SchemaNode<T>;
}

export interface SchemaStatic {
  object<T extends Record<string, unknown>>(shape: T): SchemaNode<T>;
  string(): SchemaNode<string>;
  boolean(): SchemaNode<boolean>;
  number(): SchemaNode<number>;
  any(): SchemaNode<unknown>;
  array<T>(inner: SchemaNode<T>): SchemaNode<T[]>;
}

declare const Schema: SchemaStatic;
export default Schema;
