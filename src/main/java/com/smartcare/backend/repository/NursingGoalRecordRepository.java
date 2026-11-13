package com.smartcare.backend.repository;

import com.smartcare.backend.entity.NursingGoalRecord;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.List;

public interface NursingGoalRecordRepository extends MongoRepository<NursingGoalRecord, String> {
    List<NursingGoalRecord> findByPidAndValidOrderByRecordDateAsc(String pid, Boolean valid);

    List<NursingGoalRecord> findByPidAndRecordDateAndValid(String pid, String recordDate, Boolean valid);
}
