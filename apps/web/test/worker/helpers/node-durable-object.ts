/** Only the base constructor is stubbed; lifecycle tests execute the production state machine. */
export class DurableObject<T> {
  constructor(
    protected ctx: DurableObjectState,
    protected env: T,
  ) {}
  async fetch(_request: Request): Promise<Response> {
    return new Response(null, { status: 404 })
  }
  async alarm(): Promise<void> {}
}
