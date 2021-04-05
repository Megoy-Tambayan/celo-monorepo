import {
  authenticateUser,
  ErrorMessage,
  hasValidAccountParam,
  hasValidQueryPhoneNumberParam,
  hasValidTimestamp,
  isBodyReasonablySized,
  phoneNumberHashIsValidIfExists,
  SignMessageResponse,
  SignMessageResponseFailure,
  WarningMessage,
} from '@celo/phone-number-privacy-common'
import Logger from 'bunyan'
import { Request, Response } from 'express'
import allSettled from 'promise.allsettled'
import { computeBlindedSignature } from '../bls/bls-cryptography-client'
import { respondWithError } from '../common/error-utils'
import { Counters, Histograms, Labels } from '../common/metrics'
import { getVersion } from '../config'
import { incrementQueryCount } from '../database/wrappers/account'
import { getRequestExists, storeRequest } from '../database/wrappers/request'
import { getKeyProvider } from '../key-management/key-provider'
import { Endpoints } from '../server'
import { getBlockNumber, getContractKit } from '../web3/contracts'
import { getRemainingQueryCount } from './query-quota'

allSettled.shim()

export interface GetBlindedMessagePartialSigRequest {
  account: string
  blindedQueryPhoneNumber: string
  hashedPhoneNumber?: string
  timestamp?: number
  sessionID?: string
}

export async function handleGetBlindedMessagePartialSig(
  request: Request<{}, {}, GetBlindedMessagePartialSigRequest>,
  response: Response
) {
  Counters.requests.labels(Endpoints.GET_BLINDED_MESSAGE_PARTIAL_SIG).inc()

  const logger: Logger = response.locals.logger
  logger.info({ request: request.body }, 'Request received')
  if (!request.body.sessionID) {
    logger.debug({ request: request.body }, 'Request does not have sessionID')
    Counters.signatureRequestsWithoutSessionID.inc()
  }
  logger.debug('Begin handleGetBlindedMessagePartialSig')

  try {
    if (!isValidGetSignatureInput(request.body)) {
      respondWithError(
        Endpoints.GET_BLINDED_MESSAGE_PARTIAL_SIG,
        response,
        400,
        WarningMessage.INVALID_INPUT
      )
      return
    }

    const meterAuthenticateUser = Histograms.getBlindedSigInstrumentation
      .labels('authenticateUser')
      .startTimer()
    if (
      !(await authenticateUser(request, getContractKit(), logger).finally(meterAuthenticateUser))
    ) {
      respondWithError(
        Endpoints.GET_BLINDED_MESSAGE_PARTIAL_SIG,
        response,
        401,
        WarningMessage.UNAUTHENTICATED_USER
      )
      return
    }

    const { account, blindedQueryPhoneNumber, hashedPhoneNumber } = request.body

    const errorMsgs: string[] = []
    // In the case of a blockchain connection failure, don't block user
    // but set the error status accordingly
    //
    const meterGetQueryCountAndBlockNumber = Histograms.getBlindedSigInstrumentation
      .labels('getQueryCountAndBlockNumber')
      .startTimer()
    const [_queryCount, _blockNumber] = await Promise.allSettled([
      // Note: The database read of the user's performedQueryCount
      // included here resolves to 0 on error
      getRemainingQueryCount(logger, account, hashedPhoneNumber),
      getBlockNumber(),
    ]).finally(meterGetQueryCountAndBlockNumber)

    let totalQuota = -1
    let performedQueryCount = -1
    let blockNumber = -1
    let hadBlockchainError = false
    if (_queryCount.status === 'fulfilled') {
      performedQueryCount = _queryCount.value.performedQueryCount
      totalQuota = _queryCount.value.totalQuota
    } else {
      logger.error(_queryCount.reason)
      hadBlockchainError = true
    }
    if (_blockNumber.status === 'fulfilled') {
      blockNumber = _blockNumber.value
    } else {
      logger.error(_blockNumber.reason)
      hadBlockchainError = true
    }

    if (hadBlockchainError) {
      Counters.blockchainErrors.labels(Labels.read).inc()
      errorMsgs.push(ErrorMessage.CONTRACT_GET_FAILURE)
    }

    if (_queryCount.status === 'fulfilled' && performedQueryCount >= totalQuota) {
      logger.debug('No remaining query count')
      respondWithError(
        Endpoints.GET_BLINDED_MESSAGE_PARTIAL_SIG,
        response,
        403,
        WarningMessage.EXCEEDED_QUOTA,
        performedQueryCount,
        totalQuota,
        blockNumber
      )
      return
    }

    const meterGenerateSignature = Histograms.getBlindedSigInstrumentation
      .labels('generateSignature')
      .startTimer()
    const keyProvider = getKeyProvider()
    const privateKey = keyProvider.getPrivateKey()
    const signature = computeBlindedSignature(blindedQueryPhoneNumber, privateKey, logger)
    meterGenerateSignature()

    if (await getRequestExists(request.body, logger)) {
      Counters.duplicateRequests.inc()
      logger.debug(
        'Signature request already exists in db. Will not store request or increment query count.'
      )
      errorMsgs.push(WarningMessage.DUPLICATE_REQUEST_TO_GET_PARTIAL_SIG)
    } else {
      const meterDbWriteOps = Histograms.getBlindedSigInstrumentation
        .labels('dbWriteOps')
        .startTimer()
      // TODO(Alec): Parallelize these requests
      if (!(await storeRequest(request.body, logger))) {
        logger.debug('Did not store request.')
        errorMsgs.push(ErrorMessage.FAILURE_TO_STORE_REQUEST)
      }
      if (!(await incrementQueryCount(account, logger))) {
        logger.debug('Did not increment query count.')
        errorMsgs.push(ErrorMessage.FAILURE_TO_INCREMENT_QUERY_COUNT)
      } else {
        performedQueryCount++
      }
      meterDbWriteOps()
    }

    let signMessageResponse: SignMessageResponse
    const signMessageResponseSuccess: SignMessageResponse = {
      success: !errorMsgs.length,
      signature,
      version: getVersion(),
      performedQueryCount,
      totalQuota,
      blockNumber,
    }
    if (errorMsgs.length) {
      const signMessageResponseFailure = signMessageResponseSuccess as SignMessageResponseFailure
      signMessageResponseFailure.error = errorMsgs.join(', ')
      signMessageResponse = signMessageResponseFailure
    } else {
      signMessageResponse = signMessageResponseSuccess
    }
    Counters.responses.labels(Endpoints.GET_BLINDED_MESSAGE_PARTIAL_SIG, '200').inc()
    logger.info({ response: signMessageResponse }, 'Signature retrieval success')
    response.json(signMessageResponse)
  } catch (err) {
    logger.error('Failed to get signature')
    logger.error(err)
    respondWithError(
      Endpoints.GET_BLINDED_MESSAGE_PARTIAL_SIG,
      response,
      500,
      ErrorMessage.UNKNOWN_ERROR
    )
  }
}

function isValidGetSignatureInput(requestBody: GetBlindedMessagePartialSigRequest): boolean {
  return (
    hasValidAccountParam(requestBody) &&
    hasValidQueryPhoneNumberParam(requestBody) &&
    phoneNumberHashIsValidIfExists(requestBody) &&
    isBodyReasonablySized(requestBody) &&
    hasValidTimestamp(requestBody)
  )
}
