using Narya.Database.Tests.Fixtures;

using Npgsql;

namespace Narya.Database.Tests.Common;

/// <summary>
/// Pins the isolation level Npgsql opens a transaction at when the caller does not name one.
///
/// <para>
/// This asserts THIRD-PARTY behavior, not Narya's, which is unusual for a test in this suite. It
/// earns its place because our code depends on that default: several stores open advisory-locked
/// read-then-write transactions whose correctness requires READ COMMITTED's per-statement
/// snapshot, and while those call sites now name the level explicitly, any future call site that
/// forgets inherits whatever Npgsql picks. If a driver upgrade ever changed that default to a
/// pinned snapshot level, the symptom would be a silent concurrency bug — a read that no longer
/// sees the previous lock holder's committed row — rather than an error. This test converts that
/// into a build failure with an obvious cause.
/// </para>
///
/// <para>
/// Note what is deliberately NOT tested here: a server hardened with
/// <c>default_transaction_isolation = 'repeatable read'</c>. Npgsql names an isolation level on
/// the wire for every BeginTransaction path, so it never inherits the server default, and a
/// fixture configured that way proves nothing.
/// </para>
/// </summary>
[Collection("postgres")]
public sealed class NpgsqlIsolationLevelPinnedTests(PostgresFixture fixture)
{
  [Fact]
  public async Task BeginTransactionWithoutAnExplicitLevelUsesReadCommitted()
  {
    await using var connection = new NpgsqlConnection(fixture.ConnectionString);
    await connection.OpenAsync(CancellationToken.None);

    // The bare overload — exactly what a call site that forgets to name a level would use.
    await using var transaction = await connection.BeginTransactionAsync(CancellationToken.None);

    await using var command = new NpgsqlCommand("select current_setting('transaction_isolation')", connection, transaction);
    var actual = await command.ExecuteScalarAsync(CancellationToken.None);

    Assert.Equal("read committed", actual);
  }
}
