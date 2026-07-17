using FluentResults;

using MediatR;

using Microsoft.Extensions.Logging;

namespace Narya.Application.Behaviors;

public sealed partial class LoggingBehavior<TRequest, TResponse>(ILogger<LoggingBehavior<TRequest, TResponse>> logger)
  : IPipelineBehavior<TRequest, TResponse>
  where TRequest : notnull
  where TResponse : ResultBase
{
  public async Task<TResponse> Handle(
    TRequest request, RequestHandlerDelegate<TResponse> next, CancellationToken cancellationToken)
  {
    LogHandling(logger, typeof(TRequest).Name);

    var response = await next(cancellationToken);

    if (response.IsFailed)
    {
      LogFailed(logger, typeof(TRequest).Name, string.Join("; ", response.Errors.Select(e => e.Message)));
    }

    return response;
  }

  [LoggerMessage(Level = LogLevel.Debug, Message = "Handling {RequestType}")]
  private static partial void LogHandling(ILogger logger, string requestType);

  [LoggerMessage(Level = LogLevel.Warning, Message = "{RequestType} failed: {Errors}")]
  private static partial void LogFailed(ILogger logger, string requestType, string errors);
}
