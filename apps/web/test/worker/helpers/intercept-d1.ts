/** Pause or fail real D1 statements without replacing their SQL execution. Never records parameters. */
export function interceptD1(
  database: D1Database,
  intercept: (sql: string, phase: 'before' | 'after') => Promise<void>,
): D1Database {
  function wrap(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
    return new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql)
        if (property === 'raw' || property === 'all' || property === 'run' || property === 'first') {
          return async (...args: unknown[]) => {
            await intercept(sql, 'before')
            const result = await Reflect.apply(target[property], target, args)
            await intercept(sql, 'after')
            return result
          }
        }
        return Reflect.get(target, property)
      },
    })
  }
  return new Proxy(database, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql)
      const value: unknown = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
