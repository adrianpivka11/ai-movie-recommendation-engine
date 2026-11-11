-- Run after both schema files in a TEST database. All fixture changes roll back.
BEGIN;
SET LOCAL plpgsql.check_asserts = on;
DO $$
DECLARE
  v_id uuid;
  v_row public.recommendation_jobs%ROWTYPE;
  v_first_token uuid;
  v_second_token uuid;
  v_started timestamptz;
  v_count integer;
BEGIN
  ASSERT NOT has_function_privilege('anon', 'public.claim_recommendation_job(uuid,integer,integer)', 'EXECUTE');
  ASSERT NOT has_function_privilege('authenticated', 'public.finish_recommendation_job(uuid,uuid,text,jsonb,text)', 'EXECUTE');
  ASSERT has_function_privilege('service_role', 'public.claim_recommendation_job(uuid,integer,integer)', 'EXECUTE');

  INSERT INTO public.recommendation_jobs(query) VALUES ('Test movies') RETURNING id INTO v_id;
  SELECT * INTO STRICT v_row FROM public.claim_recommendation_job(v_id, 300, 3);
  ASSERT v_row.status = 'processing' AND v_row.attempt_count = 1;
  ASSERT v_row.lock_token IS NOT NULL AND v_row.locked_until > clock_timestamp();
  v_first_token := v_row.lock_token;
  v_started := v_row.started_at;

  SELECT count(*) INTO v_count FROM public.claim_recommendation_job(v_id, 300, 3);
  ASSERT v_count = 0, 'An active lease must not be claimed twice';
  SELECT count(*) INTO v_count FROM public.finish_recommendation_job(v_id, gen_random_uuid(), 'completed', '{"movies":[],"series":[]}');
  ASSERT v_count = 0, 'A different worker must not finish the job';

  UPDATE public.recommendation_jobs SET locked_until = clock_timestamp() - interval '1 second' WHERE id = v_id;
  SELECT count(*) INTO v_count FROM public.finish_recommendation_job(v_id, v_first_token, 'completed', '{"movies":[],"series":[]}');
  ASSERT v_count = 0, 'An expired lease must not write even before reclamation';
  SELECT * INTO STRICT v_row FROM public.claim_recommendation_job(v_id, 300, 3);
  ASSERT v_row.attempt_count = 2 AND v_row.lock_token <> v_first_token;
  ASSERT v_row.started_at = v_started, 'Preserve the original start time';
  v_second_token := v_row.lock_token;

  SELECT count(*) INTO v_count FROM public.finish_recommendation_job(v_id, v_first_token, 'failed', NULL, 'Stale failure');
  ASSERT v_count = 0, 'A stale worker must not fail the new attempt';
  SELECT count(*) INTO v_count FROM public.finish_recommendation_job(v_id, v_first_token, 'queued');
  ASSERT v_count = 0, 'A stale worker must not release the new attempt';

  BEGIN
    PERFORM public.finish_recommendation_job(v_id, v_second_token, 'completed', '{"movies":[]}');
    RAISE EXCEPTION 'Malformed result was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  SELECT * INTO STRICT v_row FROM public.finish_recommendation_job(v_id, v_second_token, 'completed', '{"movies":[],"series":[]}');
  ASSERT v_row.status = 'completed' AND v_row.completed_at IS NOT NULL;
  ASSERT v_row.result = '{"movies":[],"series":[]}'::jsonb;
  ASSERT v_row.lock_token IS NULL AND v_row.locked_until IS NULL;
  SELECT count(*) INTO v_count FROM public.claim_recommendation_job(v_id);
  ASSERT v_count = 0, 'Completed jobs must never run again';

  INSERT INTO public.recommendation_jobs(query) VALUES ('Retry test') RETURNING id INTO v_id;
  SELECT * INTO STRICT v_row FROM public.claim_recommendation_job(v_id, 300, 2);
  SELECT * INTO STRICT v_row FROM public.finish_recommendation_job(v_id, v_row.lock_token, 'queued');
  ASSERT v_row.status = 'queued' AND v_row.attempt_count = 1 AND v_row.lock_token IS NULL;
  SELECT * INTO STRICT v_row FROM public.claim_recommendation_job(v_id, 300, 2);
  ASSERT v_row.attempt_count = 2;
  UPDATE public.recommendation_jobs SET locked_until = clock_timestamp() - interval '1 second' WHERE id = v_id;
  SELECT count(*) INTO v_count FROM public.claim_recommendation_job(v_id, 300, 2);
  ASSERT v_count = 0;
  SELECT * INTO STRICT v_row FROM public.recommendation_jobs WHERE id = v_id;
  ASSERT v_row.status = 'failed' AND v_row.attempt_count = 2 AND v_row.error IS NOT NULL;
  SELECT count(*) INTO v_count FROM public.claim_recommendation_job(v_id);
  ASSERT v_count = 0, 'Failed jobs are terminal';

  INSERT INTO public.recommendation_jobs(query) VALUES ('Failure test') RETURNING id INTO v_id;
  SELECT * INTO STRICT v_row FROM public.claim_recommendation_job(v_id);
  SELECT * INTO STRICT v_row FROM public.finish_recommendation_job(v_id, v_row.lock_token, 'failed', NULL, 'Please try again.');
  ASSERT v_row.status = 'failed' AND v_row.error = 'Please try again.';
  ASSERT v_row.result IS NULL AND v_row.completed_at IS NULL AND v_row.lock_token IS NULL;

  SELECT count(*) INTO v_count FROM public.claim_recommendation_job(gen_random_uuid());
  ASSERT v_count = 0, 'Missing jobs are not claimed';
  BEGIN
    PERFORM public.claim_recommendation_job(v_id, 0, 3);
    RAISE EXCEPTION 'Invalid lease was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END;
$$;
ROLLBACK;
