using Marten;

using Testcontainers.PostgreSql;

namespace Narya.Database.Tests.Fixtures;

public sealed class PostgresFixture : IAsyncLifetime
{
  private readonly PostgreSqlContainer _container = new PostgreSqlBuilder("postgres:17-alpine")
    .Build();

  public string ConnectionString => _container.GetConnectionString();

  public DocumentStore CreateStore(Action<StoreOptions>? configure = null) =>
    DocumentStore.For(options =>
    {
      options.Connection(ConnectionString);
      configure?.Invoke(options);
    });

  public Task InitializeAsync() => _container.StartAsync();
  public Task DisposeAsync() => _container.DisposeAsync().AsTask();
}

[CollectionDefinition("postgres")]
public sealed class PostgresCollection : ICollectionFixture<PostgresFixture>;
